import { describe, it, expect } from "vitest";
import {
  describeProcessSummary,
  formatCpu,
  formatMemory,
  formatProcessBadge,
} from "./process-summary";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe("formatCpu", () => {
  it("rounds to a whole percent of one core, past 100 for several cores", () => {
    expect(formatCpu(12.4)).toBe("12%");
    expect(formatCpu(0.2)).toBe("0%");
    expect(formatCpu(250.6)).toBe("251%");
  });

  it("shows a dash before the second scan could measure it", () => {
    expect(formatCpu(null)).toBe("–%");
  });
});

describe("formatMemory", () => {
  it("picks the largest unit under 1024", () => {
    expect(formatMemory(512 * 1024)).toBe("512K");
    expect(formatMemory(874 * MIB)).toBe("874M");
    expect(formatMemory(1.24 * GIB)).toBe("1.2G");
    expect(formatMemory(12.6 * GIB)).toBe("13G");
  });
});

describe("process summary", () => {
  it("is a compact badge and a spelled-out tooltip", () => {
    const summary = { cpuPercent: 12, rssBytes: 874 * MIB, count: 7 };
    expect(formatProcessBadge(summary)).toBe("12% · 874M · 7");
    expect(describeProcessSummary(summary)).toBe("12% CPU · 874M memory · 7 processes");
  });

  it("says when CPU is not measured yet, and counts one process in the singular", () => {
    expect(describeProcessSummary({ cpuPercent: null, rssBytes: 4 * MIB, count: 1 })).toBe(
      "CPU not measured yet · 4M memory · 1 process"
    );
  });
});
