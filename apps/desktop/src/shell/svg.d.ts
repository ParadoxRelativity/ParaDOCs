// The shell build loads SVGs as text (see build.mjs).
declare module '*.svg' {
  const markup: string;
  export default markup;
}
