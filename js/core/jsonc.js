"use strict";

(function (Aura) {
  /**
   * JSON the way the game reads it. Newtonsoft accepts // and /* *\/ comments and several of the data files use them,
   * so anything in the Studio that parses Data/ has to take them out first — JSON.parse does not.
   *
   * Scanned character by character instead of with a regular expression: a comment marker inside a string
   * ("http://…", "100 % /* ") is not a comment, and an escaped quote does not end a string.
   */
  function strip(text) {
    let out = "", inString = false, escaped = false;
    text = stripBom(text);
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        out += c;
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; out += c; continue; }
      if (c === "/" && text[i + 1] === "/") {
        const end = text.indexOf("\n", i);
        if (end < 0) break;
        i = end - 1;
        continue;
      }
      if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        i = (end < 0 ? text.length : end + 1);
        continue;
      }
      out += c;
    }
    return out;
  }

  /** The byte-order mark a few of the data files carry: Newtonsoft skips it, JSON.parse chokes on it. */
  const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

  /** True when taking the comments out changed anything: the file cannot be rewritten by a plain serializer. */
  const hasComments = (text) => strip(text) !== stripBom(text);

  const parse = (text, reviver) => JSON.parse(strip(text), reviver);

  Aura.jsonc = { strip, stripBom, parse, hasComments };
})(window.Aura ??= {});
