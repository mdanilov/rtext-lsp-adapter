import { ServiceConfig } from "./rtext/config"

export interface ServerInitializationOptions {
    id: number;
    hoverProvider?: boolean;
    command: string;
    args?: string[];
    rtextConfig: ServiceConfig;
}
