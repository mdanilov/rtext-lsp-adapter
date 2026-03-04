import * as fs from 'fs';
import * as path from 'path';

export interface ServiceConfig {
    file: string;
    patterns: string[];
    command: string;
    paths: string[];
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
                        const command = l;
                        const paths = extract_paths(command);
                        l = lines.shift();
                        while (l !== undefined && /\S/.test(l) && !(/:\s*$/.test(l))) {
                            l = lines.shift();
                        }
                        configs.push({ file, patterns, command, paths });
                    } else {
                        // no command line, skip
                    }
                } else {
                    l = lines.shift();
                }
            }
        }
        return configs;
    }

    // Flags that consume the next token as their value.
    const FLAGS_WITH_VALUE = new Set(['-m', '-l', '--text-ext', '--macro-path', '--def-path', '--timeout']);

    // Extract positional path arguments from a command line.
    // Skips executable tokens at the start, then collects remaining positional tokens as paths.
    function extract_paths(command: string): string[] {
        // Tokenize respecting double-quoted strings
        const tokens: string[] = [];
        const tokenRegex = /"([^"]*)"|(\S+)/g;
        let match: RegExpExecArray | null;
        while ((match = tokenRegex.exec(command)) !== null) {
            tokens.push(match[1] !== undefined ? match[1] : match[2]);
        }

        const paths: string[] = [];
        let pastExecutable = false;
        let i = 0;
        while (i < tokens.length) {
            const token = tokens[i];
            if (!pastExecutable && token.endsWith('rtext-service')) {
                pastExecutable = true;
                i++;
            } else if (FLAGS_WITH_VALUE.has(token)) {
                // known flag — skip flag and its value
                i += 2;
            } else {
                if (pastExecutable) {
                    paths.push(token);
                }
                // else: still part of the executable prefix before rtext-service
                i++;
            }
        }
        return paths;
    }
}
