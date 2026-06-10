/**
 * LSP stub for M2 — temporary replacement for the real LSP client.
 * Allows all non-LSP modes to work while LSP-dependent modes degrade
 * gracefully (fallback to tree-sitter/ctags/regex).
 *
 * M3 will rewrite this with the real LSP client.
 */

export interface WarmProc {
  rootUri: string;
  lang: string;
  alive: boolean;
}

export interface LspClient {
  getClient(root: string, lang: string): Promise<WarmProc | null>;
  hasWarmClient(root: string, lang: string): boolean;
  shutdown(): Promise<void>;
  waitForDiagnostics(uri: string, timeoutMs: number): Promise<any>;
  getCachedDiagnostics(uri: string): any[];
}

export function createLspClient(): LspClient {
  return {
    async getClient(): Promise<WarmProc | null> {
      return null;
    },
    hasWarmClient(): boolean {
      return false;
    },
    async shutdown(): Promise<void> {
      // no-op
    },
    async waitForDiagnostics(): Promise<any[]> {
      return [];
    },
    getCachedDiagnostics(): any[] {
      return [];
    },
  };
}
