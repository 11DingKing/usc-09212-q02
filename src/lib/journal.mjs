import fs from "node:fs";
import path from "node:path";

// 追加式日志：所有状态变更先落盘再应用，重启后按序重放即可恢复到故障前状态并继续聚合。
export class Journal {
  constructor(filePath) {
    this.filePath = filePath;
    this.memoryLines = filePath ? null : [];
  }

  static open(dataDir) {
    if (!dataDir) return new Journal(null);
    fs.mkdirSync(dataDir, { recursive: true });
    return new Journal(path.join(dataDir, "journal.jsonl"));
  }

  append(record) {
    const line = `${JSON.stringify(record)}\n`;
    if (this.memoryLines) {
      this.memoryLines.push(line);
    } else {
      fs.appendFileSync(this.filePath, line, "utf8");
    }
  }

  *readAll() {
    let text = "";
    if (this.memoryLines) {
      text = this.memoryLines.join("");
    } else if (fs.existsSync(this.filePath)) {
      text = fs.readFileSync(this.filePath, "utf8");
    }
    for (const line of text.split("\n")) {
      if (line.trim()) yield JSON.parse(line);
    }
  }
}
