import * as net from "net";
import * as cp from "child_process";
import * as path from "path";
import * as os from "os";
import { clearInterval } from "timers";

import * as rtextProtocol from "./protocol";
import { Context } from "./context";
import { Message } from "./message";
import { ServiceConfig } from "./config";
import { ConnectorInterface } from "./connectorManager";

export type ProgressCallback = (progress: rtextProtocol.ProgressInformation) => void;

class PendingRequest {
    public invocationId = 0;
    public command = "";
    public progressCallback?: ProgressCallback;
    public resolveFunc: Function = () => { };
    public rejectFunc: Function = () => { };
}

enum ClientState {
    Initial,
    Starting,
    StartFailed,
    Running,
    Stopping,
    Stopped
}

export class Client implements ConnectorInterface {

    readonly config: ServiceConfig;

    private _client = new net.Socket();
    private _invocationCounter = 0;
    private _connected = false;
    private _state: ClientState;
    private _onStart: Promise<void> | undefined;
    private _onStop: Promise<void> | undefined;
    private _serverProcess: cp.ChildProcess | undefined;
    private _pendingRequests: PendingRequest[] = [];
    private _reconnectTimeout?: NodeJS.Timeout;
    private _keepAliveTask?: NodeJS.Timeout;
    private _responseData: Buffer = Buffer.alloc(0);
    private static LOCALHOST = "127.0.0.1";

    constructor(config: ServiceConfig) {
        this.config = config;
        this._state = ClientState.Initial;
    }

    public async restart(): Promise<void> {
        await this.stop();
        await this.start();
    }

    public async start(): Promise<void> {
        if (this._state === ClientState.Stopping) {
            throw new Error(`Client is currently stopping. Can only restart a full stopped client`);
        }

        if (this._onStart !== undefined) {
            return this._onStart;
        }

        this._state = ClientState.Starting;

        return this._onStart = this.runRTextService(this.config).then(port => {
            this._client = new net.Socket();
            this._client.on("data", (data) => this.onData(data));
            this._client.on("close", () => this.onClose());
            this._client.on("error", (error) => this.onError(error));

            this._keepAliveTask = setInterval(() => {
                console.log("Sending keep alive `version` request");
                this.getVersion()
                    .then((response) => {
                        console.log("Keep alive, got version " + response.version);
                    }).catch(error => {
                        console.error(error.message);
                    });
            }, 30 * 1000);

            this._state = ClientState.Running;

            return new Promise<void>(resolve => {
                this._client.connect(port, Client.LOCALHOST, () => {
                    this.onConnect(port, Client.LOCALHOST);
                    resolve();
                });
            });
        }).catch(error => {
            this._state = ClientState.StartFailed;
            this._onStart = undefined;
            throw error;
        });
    }

    public getContextInformation(context: Context): Promise<rtextProtocol.ContextInformationResponse> {
        return this.send({ command: "context_info", context: context.lines, column: context.pos });
    }

    public getContentCompletion(context: Context): Promise<rtextProtocol.ContentCompleteResponse> {
        return this.send({ command: "content_complete", context: context.lines, column: context.pos });
    }

    public getLinkTargets(context: Context): Promise<rtextProtocol.LinkTargetsResponse> {
        return this.send({ command: "link_targets", context: context.lines, column: context.pos });
    }

    public findElements(pattern: string): Promise<rtextProtocol.FindElementsResponse> {
        return this.send({ command: "find_elements", search_pattern: pattern });
    }

    public async stop(): Promise<void> {
        if (this._state === ClientState.Stopped || this._state === ClientState.Initial) {
            return;
        }

        if (this._state === ClientState.Stopping) {
            if (this._onStop !== undefined) {
                return this._onStop;
            } else {
                throw new Error(`Client is stopping but no stop promise available.`);
            }
        }

        if (this._reconnectTimeout) {
            clearTimeout(this._reconnectTimeout);
        }

        if (this._keepAliveTask) {
            clearInterval(this._keepAliveTask);
            this._keepAliveTask = undefined;
        }

        this._state = ClientState.Stopping;

        return this._onStop = this.stopService().finally(() => {
            this.checkProcessDied(this._serverProcess);
            this._serverProcess = undefined;
            this._state = ClientState.Stopped;
            this._onStart = undefined;
            this._onStop = undefined;
        });
    }

    private checkProcessDied(childProcess: cp.ChildProcess | undefined): void {
        if (!childProcess || childProcess.pid === undefined) {
            return;
        }
        setTimeout(() => {
            // Test if the process is still alive. Throws an exception if not
            try {
                if (childProcess.pid !== undefined) {
                    process.kill(childProcess.pid, 0);
                    childProcess.kill('SIGKILL');
                }
            } catch (error) {
                // All is fine.
            }
        }, 2000);
    }

    public loadModel(progressCallback?: ProgressCallback): Promise<rtextProtocol.LoadModelResponse> {
        return this.send({ command: "load_model" }, progressCallback);
    }

    public stopService(): Promise<void> {
        return this.send({ command: "stop" });
    }

    public getVersion(): Promise<rtextProtocol.VersionResponse> {
        return this.send({ command: "version" });
    }

    public send(data: any, progressCallback?: ProgressCallback): Promise<any> {
        if (!this._connected) {
            return Promise.reject(new Error("RText service is not connected"));
        }

        data.type = "request";
        data.version = 1;
        data.invocation_id = this._invocationCounter;

        console.debug("Tx: " + JSON.stringify(data));

        const request = new PendingRequest();
        request.invocationId = this._invocationCounter;
        request.progressCallback = progressCallback;
        request.command = data.command;
        this._pendingRequests.push(request);

        const payload = Message.serialize(data);

        this._client.write(payload);
        this._invocationCounter++;

        return new Promise<any>((resolve, reject) => {
            request.resolveFunc = resolve;
            request.rejectFunc = reject;
        });
    }

    private onError(error: Error) {
        console.log("Connection error: " + error.message);
    }

    private onConnect(port: number, host: string) {
        this._connected = true;
        console.log("Connected to " + host + ":" + port);
    }

    private onClose() {
        this._connected = false;
        console.log("Connection closed");

        for (let request of this._pendingRequests) {
            if (request.rejectFunc) {
                request.rejectFunc(new Error('RText service connection closed'));
            }
        }

        if (this._keepAliveTask) {
            clearInterval(this._keepAliveTask);
            this._keepAliveTask = undefined;
        }

        if (this._state == ClientState.Running) {
            this._reconnectTimeout = setTimeout(() => { this.start(); }, 3000);
        }
    }

    private onData(data: any) {
        this._responseData = Buffer.concat([this._responseData, data], this._responseData.length + data.length);
        let obj: any;
        while (obj = Message.extract(this._responseData)) {
            this._responseData = this._responseData.slice(obj._dataLength);
            console.debug("Rx: " + JSON.stringify(obj));

            const found = this._pendingRequests.findIndex((request) => {
                return request.invocationId === obj.invocation_id;
            });

            if (found !== -1) {
                const pending = this._pendingRequests[found];
                if (obj.type === "response") {
                    if (pending.resolveFunc) {
                        pending.resolveFunc(obj);
                    }
                    this._pendingRequests.splice(found, 1);
                } else if (obj.type === "progress" &&
                    pending.progressCallback) {
                    pending.progressCallback(obj);
                } else if (obj.type === "unknown_command_error") {
                    console.log("Error: unknown command - " + obj.command);
                    this._pendingRequests.splice(found, 1);
                } else if (obj.type === "unsupported_version") {
                    console.log("Error: unsupported version " + obj.version);
                    this._pendingRequests.splice(found, 1);
                }
            }
        }
    }

    private transformCommand(command: string): string {
        let m = command.match(/^cmd\s*\/c\s*/);
        if (m && os.platform() !== 'win32') {
            command = command.substring(m[0].length);
        }
        else if (!m && os.platform() === 'win32') {
            command = "cmd \/c " + command;
        }
        return command;
    }

    private async runRTextService(config: ServiceConfig): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            const configCommand = this.transformCommand(config.command.trim());
            const command = configCommand.split(' ')[0];
            const args = configCommand.split(' ').slice(1);
            const cwd = path.dirname(config.file);
            console.log(`Working directory ${cwd}`);
            console.log(`Run ${configCommand}`);
            const serverProcess = cp.spawn(command, args, { cwd: cwd, shell: true });
            if (!serverProcess || !serverProcess.pid) {
                reject(new Error(`Launching server using command ${this.config.command} failed.`));
            }
            this._serverProcess = serverProcess;
            serverProcess.on('exit', (code, signal) => {
                if (this._state === ClientState.Starting) {
                    reject(new Error(`Launching server using command ${this.config.command} failed.`));
                }
            });
            serverProcess.on('error', (error) => {
                reject(new Error(`Failed to run service ${this.config.command}, reason: ${error.message}`));
            });
            serverProcess.stderr.on('data', (data: any) => {
                const stderr = data.toString();
                console.error(stderr);
                if (stderr.match(/License checkout failed/)) {
                    reject(new Error(stderr));
                }
            });
            serverProcess.stdout.on('data', (data: any) => {
                const stdout: string = data.toString();
                console.log(stdout);
                const foundPort = stdout.match(/.*listening on port (\d*)/);
                if (foundPort) {
                    const port: number = parseInt(foundPort[1]);
                    resolve(port);
                }
            });
        });
    }
}
