export function readIconFiles(publicDirectory: string): Promise<{
 links: string;
 files: Map<string, { bytes: Uint8Array; type: string }>;
}>;
export function seedIcons(): {
 name: string;
 config(config: { root?: string; publicDir?: string | false }): Promise<{ define: Record<string, string> }>;
};
