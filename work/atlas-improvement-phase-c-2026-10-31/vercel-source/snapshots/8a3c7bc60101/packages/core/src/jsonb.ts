const encoder = new TextEncoder();

function stringBytes(value: string): number {
    // PostgreSQL UTF-8 jsonb disallows NUL and unpaired UTF-16 surrogates.
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code === 0) throw new Error("保存できない文字が含まれています。");
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(++index);
            if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("保存できない文字が含まれています。");
        } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error("保存できない文字が含まれています。");
    }
    return encoder.encode(JSON.stringify(value)).length;
}

function numberBytes(value: number): number {
    if (!Number.isFinite(value)) throw new Error("数値のデータが正しくありません。");
    const text = JSON.stringify(value);
    const exponent = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(text);
    if (!exponent) return text.length;
    const digits = exponent[2].length + (exponent[3]?.length ?? 0);
    const decimalPosition = exponent[2].length + Number(exponent[4]);
    // jsonb expands scientific notation using numeric output without rounding.
    if (decimalPosition <= 0) return exponent[1].length + 2 - decimalPosition + digits;
    return exponent[1].length + Math.max(decimalPosition, digits) + (decimalPosition < digits ? 1 : 0);
}

/** Byte length of UTF-8 PostgreSQL `jsonb::text` for plain JSON values emitted by
 * JSON.stringify. Key order does not affect length. Unlike raw JSON, jsonb adds
 * separator spaces and expands exponents (1e-300 becomes a long decimal).
 * https://www.postgresql.org/docs/17/datatype-json.html#JSON-INPUT-OUTPUT
 */
export function jsonbByteLength(value: unknown): number {
    if (value === null) return 4;
    if (typeof value === "boolean") return value ? 4 : 5;
    if (typeof value === "number") return numberBytes(value);
    if (typeof value === "string") return stringBytes(value);
    if (Array.isArray(value)) return 2 + Math.max(0, value.length - 1) * 2 + Array.from(value).reduce((bytes, item) => bytes + jsonbByteLength(item === undefined ? null : item), 0);
    if (value && typeof value === "object") {
        const entries = Object.entries(value).filter(([, item]) => item !== undefined);
        return 2 + Math.max(0, entries.length - 1) * 2 + entries.reduce((bytes, [key, item]) => bytes + stringBytes(key) + 2 + jsonbByteLength(item), 0);
    }
    throw new Error("保存するデータが正しくありません。");
}
