// Small valid PNG signature and IHDR, sufficient for the original-format validator.
export const PNG=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="),c=>c.charCodeAt(0));
