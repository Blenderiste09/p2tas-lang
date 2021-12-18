import * as vscode from 'vscode';
import * as net from 'net';
import * as path from'path';

enum TASStatus {
    Inactive, Playing, Paused, Skipping
}

export class TASServer {
    static host = 'localhost';
    static port = 6555;
    socket: net.Socket;

    // This data should only be updated from SAR data
    gameLocation: string | undefined;
    activeTASses: string[2] | undefined;
    playbackRate = 1.0;
    status = TASStatus.Inactive;
    currentTick = 0; // Only valid when active

    constructor() {
        this.socket = new net.Socket();
    }

    connect() {
        this.socket.connect(TASServer.port, TASServer.host, () => vscode.window.showInformationMessage("Successfully connected to SAR!"));
        this.socket.on('error', () => vscode.window.showInformationMessage("Failed to connect to SAR."));
        this.socket.on('close', () => vscode.window.showInformationMessage("Closed connection to SAR."));
        this.socket.on('data', (data) => this.processData(data));
    }

    // ----------------------------------------------
    //                 Sending data
    // ----------------------------------------------

    requestPlayback() {
        if (!this.checkSocket())
            return;
    
        var scriptPath = vscode.window.activeTextEditor?.document?.fileName;
        if (scriptPath === undefined) return;

        // If we have no game location, get the plain filename and hope for the best
        if (this.gameLocation === undefined) {
            scriptPath = path.basename(scriptPath);
        } else {
            if (!scriptPath.startsWith(this.gameLocation)) {
                vscode.window.showErrorMessage("Failed to play: file is not in the `Portal 2/tas` directory.");
                return;
            }
            
            scriptPath = scriptPath.slice(this.gameLocation.length);
        }

        // Check it's actually a p2tas
        if (!scriptPath.endsWith(".p2tas")) {
            vscode.window.showErrorMessage("Failed to play: file is not a TAS script.");
            return;
        }
        scriptPath = scriptPath.slice(0, scriptPath.length - 6); // remove extension

        // Edge cases to test for:
        // - remove and check file extension
        // - check and remove game path

        vscode.window.showInformationMessage("Requesting playback for file " + scriptPath);
    
        var buf = Buffer.alloc(9 + scriptPath.length, 0);
        buf.writeUInt32BE(scriptPath.length, 1);
        buf.write(scriptPath, 5);
        buf.writeUInt32BE(0, 5 + scriptPath.length);
    
        this.socket.write(buf);
    }
    requestStopPlayback() {
        if (!this.checkSocket())
            return;
        this.socket.write(Buffer.alloc(1, 1));
    }
    requestRatePlayback(rate: number) {
        if (!this.checkSocket())
            return;
        var buf = Buffer.alloc(5, 2);
        buf.writeFloatBE(rate, 1);
        console.log(buf);
        this.socket.write(buf);
    }
    requestStatePlaying() {
        if (!this.checkSocket())
            return;
        this.socket.write(Buffer.alloc(1, 3));
    }
    requestStatePaused() {
        if (!this.checkSocket())
            return;
        this.socket.write(Buffer.alloc(1, 4));
    }
    requestFastForward(tick: number, pause_after: boolean) {
        if (!this.checkSocket())
            return;
        var buf = Buffer.alloc(6, 5);
        buf.writeUInt32BE(tick, 1);
        if (pause_after)
            buf.writeUInt8(1, 5);
        else
            buf.writeUInt8(0, 5);
        this.socket.write(buf);
    }
    requestNextPauseTick(tick: number) {
        if (!this.checkSocket())
            return;
        var buf = Buffer.alloc(5, 2);
        buf.writeUInt32BE(tick, 1);
        this.socket.write(buf);
    }
    requestTickAdvance() {
        if (!this.checkSocket())
            return;
        this.socket.write(Buffer.alloc(1, 7));
    }

    // ----------------------------------------------
    //                Receiving data
    // ----------------------------------------------

    processData(data: Buffer) {}

    // ----------------------------------------------
    //                    Utils
    // ----------------------------------------------

    checkSocket(): boolean {
        if (this.socket === undefined) {
            vscode.window.showErrorMessage("Not connected to SAR.");
            return false;
        }

        if (this.socket.connecting) {
            vscode.window.showErrorMessage("Socket connecting.... Please try again later.");
            return false;
        }

        if (this.socket.destroyed) {
            vscode.window.showErrorMessage("Socket disconnected.... Please connect to SAR.");
            return false;
        }

        return true;
    }
}
