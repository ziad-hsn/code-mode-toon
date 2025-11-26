import * as path from "path";
import * as os from "os";

export class PathNormalizer {
    constructor(private projectRoot: string) { }

    setProjectRoot(projectRoot: string) {
        this.projectRoot = PathNormalizer.expandPath(projectRoot);
    }

    normalizeArguments(args: any): any {
        if (args === undefined || args === null) {
            return args;
        }
        if (typeof args === "string" && this.shouldNormalizePath(args)) {
            return this.normalizePath(args);
        }
        if (Array.isArray(args)) {
            return args.map((value) => this.normalizeArguments(value));
        }
        if (typeof args === "object") {
            const normalized: Record<string, any> = {};
            for (const [key, value] of Object.entries(args)) {
                normalized[key] = this.normalizeArguments(value);
            }
            return normalized;
        }
        return args;
    }

    private shouldNormalizePath(value: string): boolean {
        if (typeof value !== "string" || value.length === 0) {
            return false;
        }
        const trimmed = value.trim();
        return (
            trimmed.startsWith('/') ||
            trimmed.startsWith('./') ||
            trimmed.startsWith('../') ||
            trimmed.startsWith('file://') ||
            trimmed.startsWith('~') ||
            trimmed.startsWith('\\') ||
            /^[A-Za-z]:[\\/]/.test(trimmed)
        );
    }

    normalizePath(inputPath: string): string {
        let p = inputPath;
        // Normalize common path quirks for MCP tools (Windows drive prefix, file://, rel->abs)
        if (p.startsWith('/C:') || p.startsWith('/c:')) {
            p = p.substring(1);
        }
        // Handle file:// URIs
        if (p.startsWith('file:///')) {
            p = p.substring(8);
        }
        // Preserve UNC/network paths (don't prefix with project root)
        const isUncPath = p.startsWith('\\\\') || p.startsWith('//');
        if (isUncPath) {
            return process.platform === 'win32' ? p.replace(/\//g, '\\') : p;
        }
        // Convert relative paths to absolute
        if (!p.includes(':') && !p.startsWith('/')) {
            p = `${this.projectRoot}/${p}`;
        }

        // On Windows, convert forward slashes to backslashes for absolute paths
        // This fixes mcp-language-server file reading issues
        if (process.platform === 'win32' && p.match(/^[A-Za-z]:/)) {
            p = p.replace(/\//g, '\\');
        }

        return p;
    }

    normalizePathsInResult(result: any): any {
        if (typeof result === 'string') {
            // Fix Windows paths in text results: /C:/ -> C:/
            let normalized = result.replace(/\/([A-Za-z]):\//g, '$1:/');

            // On Windows, convert forward slashes to backslashes in absolute paths
            if (process.platform === 'win32') {
                normalized = normalized.replace(/([A-Za-z]:)\/([^\s\n]*)/g, (match, drive, rest) => {
                    return drive + '\\' + rest.replace(/\//g, '\\');
                });
            }

            return normalized;
        }
        if (Array.isArray(result)) {
            return result.map(item => this.normalizePathsInResult(item));
        }
        if (result && typeof result === 'object') {
            const normalized: any = {};
            for (const [key, value] of Object.entries(result)) {
                if (key === 'uri' && typeof value === 'string') {
                    normalized[key] = this.normalizePath(value);
                } else {
                    normalized[key] = this.normalizePathsInResult(value);
                }
            }
            return normalized;
        }
        return result;
    }

    static expandPath(input: string): string {
        if (!input) {
            return input;
        }
        if (input === '~') {
            return os.homedir();
        }
        if (input.startsWith('~/')) {
            return path.join(os.homedir(), input.slice(2));
        }
        return input;
    }
}
