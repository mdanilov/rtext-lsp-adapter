import * as fs from 'fs';
import * as path from 'path';

export interface ServiceConfig {
    file: string;
    patterns: string[];
    command: string;
}

export namespace Config {
    export function find_service_config(file: string): ServiceConfig | undefined {
        let last_dir;
        let dir = path.resolve(path.dirname(file));
        const search_pattern = file_pattern(file);
        while (dir != last_dir) {
            const config_file = `${dir}/.rtext`;
            if (fs.existsSync(config_file)) {
                const configs = parse_config_file(config_file);
                const config = configs.find(s => {
                    return s.patterns.some(p => p === search_pattern);
                });
                if (config) {
                    return config
                }
            }
            last_dir = dir;
            dir = path.dirname(dir);
        }
    }

    export function file_pattern(file: string): string {
        const ext = path.extname(file);
        if (ext.length > 0) {
            return `*${ext}`;
        } else {
            return path.basename(file);
        }
    }

    export function parse_config_file(file: string): ServiceConfig[] {
        const configs: ServiceConfig[] = [];
        const contents = fs.readFileSync(file, 'utf-8');
        if (contents) {
            const lines = contents.split('\n');
            let l = lines.shift();
            while (l) {
                const found = l.match(/^(.+):\s*$/);
                if (found) {
                    const patterns = found[1].split(",").map(s => s.trim());
                    l = lines.shift();
                    if (l && /\S/.test(l) && !(/:\s*$/.test(l))) {
                        configs.push({ file, patterns, command: l });
                        l = lines.shift();
                    }
                } else {
                    l = lines.shift();
                }
            }
        }
        return configs;
    }
}
