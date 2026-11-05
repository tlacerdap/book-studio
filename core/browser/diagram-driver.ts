// Runs inside a hidden window: draws one diagram (mermaid text) and hands back the SVG. Monochrome, to match the book.

declare const mermaid: {
  initialize(config: unknown): void;
  parse(code: string): Promise<unknown>;
  render(id: string, code: string): Promise<{ svg: string }>;
};

const ink = "#1f1e1d";
mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  htmlLabels: false,
  fontFamily: '"Hanken Grotesk", Helvetica, Arial, sans-serif',
  flowchart: { htmlLabels: false, curve: "basis" },
  themeVariables: {
    background: "#ffffff",
    primaryColor: "#ffffff",
    primaryTextColor: ink,
    primaryBorderColor: ink,
    secondaryColor: "#efefef",
    secondaryTextColor: ink,
    secondaryBorderColor: ink,
    tertiaryColor: "#f7f7f7",
    tertiaryTextColor: ink,
    tertiaryBorderColor: "#777777",
    lineColor: ink,
    textColor: ink,
    mainBkg: "#ffffff",
    nodeBorder: ink,
    clusterBkg: "#f7f7f7",
    clusterBorder: "#777777",
    edgeLabelBackground: "#ffffff",
    noteBkgColor: "#f1f1f1",
    noteTextColor: ink,
    noteBorderColor: "#777777",
    actorBkg: "#ffffff",
    actorBorder: ink,
    actorTextColor: ink,
    signalColor: ink,
    signalTextColor: ink,
    labelBoxBkgColor: "#efefef",
    labelBoxBorderColor: ink,
    labelTextColor: ink,
    loopTextColor: ink,
  },
});

(window as unknown as { drawDiagram: (code: string) => Promise<{ ok: boolean; svg?: string; message?: string }> }).drawDiagram = async (code: string) => {
  try {
    await mermaid.parse(code);
    const { svg } = await mermaid.render(`d${Math.random().toString(36).slice(2)}`, code);
    return { ok: true, svg };
  } catch (e) {
    return { ok: false, message: String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200) };
  }
};
