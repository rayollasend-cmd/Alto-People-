export interface ForwarderOptions {
  url: string;
  token: string;
  fetch?: typeof fetch;
  write: (line: string) => void;
  log?: (line: string) => void;
}

export function createForwarder(o: ForwarderOptions): (line: string) => Promise<void>;
