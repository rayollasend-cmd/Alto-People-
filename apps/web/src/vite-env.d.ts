/// <reference types="vite/client" />

// Font packages whose entry point is a stylesheet (their exports map "." to
// index.css). TypeScript 7 checks side-effect imports by default and cannot
// see a stylesheet behind a bare package name, so they are declared here.
declare module '@fontsource-variable/geist';
declare module '@fontsource-variable/cormorant-garamond';
