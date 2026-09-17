// Shared by the background worker, player controller, and regression tests.
(function (root) {
  function checkedEnd(ranges, position) {
    let end = position;
    for (const [start, stop] of [...ranges].sort((a, b) => a[0] - b[0])) {
      if (start > end + 0.001) break;
      if (stop > end) end = stop;
    }
    return end;
  }

  function nextRange(ranges, position, duration, size) {
    const start = checkedEnd(ranges, position);
    if (start >= duration) return null;
    return [start, Math.min(duration, start + size)];
  }

  function skipTarget(ranges, position) {
    let target = position;
    for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
      if (range.start <= target && target < range.end) target = range.end;
    }
    return target;
  }

  const api = { checkedEnd, nextRange, skipTarget };
  if (typeof module !== 'undefined') module.exports = api;
  else root.ytsbTimeline = api;
})(globalThis);
