import { describe, expect, it } from "vitest";
import { detectLanguage, foreignLanguageName, postLanguage } from "../src/index.ts";

describe("detectLanguage", () => {
  it.each([
    ["en", "A coding agent for the terminal. It reads your repo, plans the change and opens a pull request with tests."],
    ["zh", "一个基于 Claude Code 的多智能体编排工具，支持并行运行多个编码代理，并自动合并结果。"],
    ["ja", "Claude Code のためのプラグインです。ターミナルから簡単にエージェントを管理できます。"],
    ["ko", "터미널에서 실행되는 AI 코딩 에이전트입니다. 저장소를 읽고 변경 사항을 제안합니다."],
    ["ru", "Агент для программирования, который работает в терминале и сам пишет тесты для вашего кода."],
    ["uk", "Інструмент для роботи з агентами в терміналі. Він читає ваш репозиторій і пропонує зміни."],
    ["es", "Un agente de programación para la terminal que lee el repositorio y propone cambios con pruebas."],
    ["pt", "Uma ferramenta para gerenciar agentes de código no terminal, com suporte a vários modelos. Você pode usar isso também."],
    ["fr", "Un agent de programmation pour le terminal qui lit votre dépôt et propose des modifications avec des tests."],
    ["de", "Ein Werkzeug für die Kommandozeile, das mit mehreren Agenten arbeitet und die Ergebnisse zusammenführt."],
    ["ar", "أداة برمجة تعمل في الطرفية وتقرأ المستودع وتقترح التغييرات"],
  ])("detects %s", (lang, text) => {
    expect(detectLanguage(text)).toBe(lang);
  });

  // Short titles, where the shared words (de, la, en, un) matter most.
  it.each([
    ["en", "Show HN: An agent that writes the tests for you"],
    ["es", "Un agente que escribe las pruebas por ti"],
    ["pt", "Um agente que escreve os testes para você"],
    ["fr", "Un agent qui écrit les tests pour vous"],
    ["de", "Ein Agent, der die Tests für dich schreibt"],
    ["it", "Un agente che scrive i test per te"],
    ["nl", "Een agent die de tests voor je schrijft"],
    ["ja", "Claude Code 入門ガイド"],
    ["ja", "生成AI開発環境構築の手引き"],
    ["zh", "基于大模型的代码审查工具"],
  ])("detects %s in a short title: %s", (lang, title) => {
    expect(detectLanguage(title)).toBe(lang);
  });

  it("ignores code blocks, inline code and URLs", () => {
    const readme = [
      "# 智能体工具",
      "这是一个用于管理编码代理的命令行工具，可以同时运行多个任务。",
      "```bash\nnpm install -g the-tool && the-tool --help for all of the options and the flags\n```",
      "运行 `the-tool start --with-the-default-config` 即可开始。详情见 https://example.com/docs/for/the/tool",
    ].join("\n");
    expect(detectLanguage(readme)).toBe("zh");
  });

  it("calls a Chinese README with English names in it Chinese", () => {
    expect(detectLanguage("Claude Code MCP Server：让 Claude Code 直接读取你的 Obsidian 笔记和 Notion 页面")).toBe("zh");
  });

  it("keeps an English README with a link to its Chinese translation English", () => {
    const readme = "English | [简体中文](README.zh-CN.md)\n\nPatchwork is an agent that reviews your pull requests and leaves comments on the diff. It works with Claude Code and Codex, and runs in CI or on your machine.";
    expect(detectLanguage(readme)).toBe("en");
  });

  it("says und when there is too little to tell", () => {
    expect(detectLanguage("")).toBe("und");
    expect(detectLanguage("Patchwork")).toBe("und");
    expect(detectLanguage("acme/patchwork: MCP server")).toBe("und");
  });
});

describe("postLanguage", () => {
  it("reads the title and the extracted text together", () => {
    expect(postLanguage("acme/agentkit", "一个在终端里运行的编码代理，可以读取仓库并提出修改建议。")).toBe("zh");
    expect(postLanguage("Show HN: Patchwork – an agent for the terminal", null)).toBe("en");
  });
});

describe("foreignLanguageName", () => {
  it("names only languages worth flagging", () => {
    expect(foreignLanguageName("zh")).toBe("Chinese");
    expect(foreignLanguageName("en")).toBeNull();
    expect(foreignLanguageName("und")).toBeNull();
    expect(foreignLanguageName(null)).toBeNull();
    expect(foreignLanguageName("xx")).toBeNull();
    expect(foreignLanguageName("toString")).toBeNull();
  });
});
