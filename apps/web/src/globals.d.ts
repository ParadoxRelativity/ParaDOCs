/** The release this client was built from, set by vite.config.ts. Null if unknown. */
declare const __PARADOCS_VERSION__: string | null;

/** rtf.js's metafile renderers, loaded alone (lib/windowsPictures.ts) rather than with its RTF reader. */
declare module 'rtf.js/dist/EMFJS.bundle.min.js' {
  export * from 'rtf.js/dist/src/emfjs/index';
}
declare module 'rtf.js/dist/WMFJS.bundle.min.js' {
  export * from 'rtf.js/dist/src/wmfjs/index';
}
