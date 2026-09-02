import { execFileSync } from "node:child_process";

function asBuffer(output) {
  if (Buffer.isBuffer(output)) return output;
  if (output instanceof Uint8Array) {
    return Buffer.from(output.buffer, output.byteOffset, output.byteLength);
  }
  return Buffer.from(String(output), "utf8");
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} contains a path that is not valid UTF-8`);
  }
}

export function parseNulDelimitedGitRecords(output, label = "Git -z output") {
  const bytes = asBuffer(output);
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0) throw new Error(`${label} must end with NUL`);
  const records = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index === start) throw new Error(`${label} contains an empty record`);
    records.push(bytes.subarray(start, index));
    start = index + 1;
  }
  return records;
}

export function parseNulDelimitedGitPaths(output, label = "git ls-files -z") {
  return parseNulDelimitedGitRecords(output, label).map((record) =>
    decodeUtf8(record, label),
  );
}

export function parseNulDelimitedGitIndexEntries(
  output,
  label = "git ls-files --stage -z",
) {
  return parseNulDelimitedGitRecords(output, label).map((record) => {
    const separator = record.indexOf(0x09);
    if (separator <= 0 || separator === record.length - 1) {
      throw new Error(`${label} contains a malformed index record`);
    }
    const metadata = decodeUtf8(record.subarray(0, separator), label);
    const match = metadata.match(/^(\d{6}) ([0-9a-f]+) ([0-3])$/);
    if (!match) throw new Error(`${label} contains malformed index metadata`);
    return {
      mode: match[1],
      objectId: match[2],
      stage: Number(match[3]),
      path: decodeUtf8(record.subarray(separator + 1), label),
    };
  });
}

export function gitPathExistsAtRef(root, ref, pathname) {
  const paths = parseNulDelimitedGitPaths(
    execFileSync("git", ["ls-tree", "--name-only", "-z", ref, "--", pathname], {
      cwd: root,
    }),
    "git ls-tree --name-only -z",
  );
  return paths.includes(pathname);
}
