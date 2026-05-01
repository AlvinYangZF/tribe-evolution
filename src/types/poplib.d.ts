declare module 'poplib' {
  import { EventEmitter } from 'events';

  interface POP3ClientOptions {
    enabletls?: boolean;
    ignoretlserrs?: boolean;
    debug?: boolean;
    tlsopts?: Record<string, unknown>;
  }

  class POP3Client extends EventEmitter {
    constructor(port: number, host: string, options?: POP3ClientOptions);
    login(username: string, password: string): void;
    list(): void;
    retr(msgnumber: number): void;
    quit(): void;

    on(event: 'connect', listener: () => void): this;
    on(event: 'login', listener: (status: boolean, rawdata?: string) => void): this;
    on(event: 'list', listener: (status: boolean, data: { Count: number; msgcount: number }) => void): this;
    on(event: 'retr', listener: (status: boolean, msgnumber: number, data: string) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
  }

  export = POP3Client;
}
