"use strict";

(function (Aura) {


  // Paths and file access through the File System Access API (Chrome / Edge). Paths are always "/"-separated and relative
  // to the project folder.

  const hasFolderAccess = typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";

  const joinPath = (...parts) => parts.filter(Boolean).join("/").replace(/\\/g, "/").replace(/\/+/g, "/");
  const dirName = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const baseName = (p) => p.slice(p.lastIndexOf("/") + 1);
  const stripExt = (name) => name.replace(/\.[^./]+$/, "");

  /** Resolves "." and ".." and backslashes. */
  function normalizePath(p) {
    const out = [];
    for (const part of p.replace(/\\/g, "/").split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return out.join("/");
  }

  async function readText(fileHandle) {
    return (await fileHandle.getFile()).text();
  }

  async function readJson(fileHandle) {
    return JSON.parse(await readText(fileHandle));
  }

  /** Writes a Blob, string or buffer into a file handle, replacing its contents. */
  async function writeHandle(fileHandle, data) {
    const stream = await fileHandle.createWritable();
    try {
      await stream.write(data);
    } finally {
      await stream.close();
    }
  }

  async function writeInDir(dirHandle, name, data) {
    const fileHandle = await dirHandle.getFileHandle(name, { create: true });
    await writeHandle(fileHandle, data);
    return fileHandle;
  }

  async function fileExists(dirHandle, name) {
    try {
      await dirHandle.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  /** Saves a Blob through the browser's download, for files that can't be written into the project. */
  function downloadBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked late: some browsers start reading the URL only after click() returns.
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  }

  async function ensurePermission(handle, mode = "readwrite") {
    const options = { mode };
    if ((await handle.queryPermission?.(options)) === "granted") return true;
    return (await handle.requestPermission?.(options)) === "granted";
  }

  Aura.fs = { hasFolderAccess, joinPath, dirName, baseName, stripExt, normalizePath, readText, readJson, writeHandle, writeInDir, fileExists, downloadBlob, ensurePermission };
})(window.Aura ??= {});
