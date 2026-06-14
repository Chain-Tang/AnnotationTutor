export function lineDiff(before: string, after: string): string {
  const left = before.split(/\r?\n/);
  const right = after.split(/\r?\n/);
  let prefix = 0;
  while (
    prefix < left.length &&
    prefix < right.length &&
    left[prefix] === right[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return [
    ...left.slice(0, prefix).map((line) => `  ${line}`),
    ...left
      .slice(prefix, left.length - suffix)
      .map((line) => `- ${line}`),
    ...right
      .slice(prefix, right.length - suffix)
      .map((line) => `+ ${line}`),
    ...left
      .slice(left.length - suffix)
      .map((line) => `  ${line}`)
  ].join("\n");
}
