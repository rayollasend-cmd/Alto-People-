import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom is reused across tests; explicit cleanup prevents leakage.
afterEach(() => cleanup());
