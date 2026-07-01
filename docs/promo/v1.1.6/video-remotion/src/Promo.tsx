import { Audio } from "@remotion/media";
import type { CSSProperties } from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { VIDEO_FPS } from "./constants";

type Scene = {
  start: number;
  duration: number;
  eyebrow: string;
  title: string;
  body?: string;
  caption: string;
  kind: "hook" | "risk" | "screenshot" | "plugin" | "library" | "close";
};

const seconds = (value: number) => Math.round(value * VIDEO_FPS);

const scenes: Scene[] = [
  {
    start: seconds(0),
    duration: seconds(9),
    eyebrow: "AI Skills Workbench",
    title: "装得越多，越怕看不清。",
    body: "GitHub 仓库、/plugin install、工具目录，开始挤在一起。",
    caption: "AI Skills 越装越多",
    kind: "hook",
  },
  {
    start: seconds(8.2),
    duration: seconds(15),
    eyebrow: "The Daily Mess",
    title: "这条入口，到底会动哪里？",
    body: "来源、版本、路径、发布目标，任何一个看不清都会让更新变得犹豫。",
    caption: "来源、版本、路径，开始看不清",
    kind: "risk",
  },
  {
    start: seconds(22.6),
    duration: seconds(16),
    eyebrow: "See Before Acting",
    title: "仓库、Skill、插件入口放到一张桌面上。",
    caption: "先看来源，再决定要不要行动",
    kind: "screenshot",
  },
  {
    start: seconds(38),
    duration: seconds(21),
    eyebrow: "Plugin Entry Index",
    title: "识别入口，不自动安装。",
    body: "README 和 manifest 里的命令被收拢，关联来源仓库和 Skill。",
    caption: "插件入口被收拢成索引",
    kind: "plugin",
  },
  {
    start: seconds(58.4),
    duration: seconds(20),
    eyebrow: "Safety Boundary",
    title: "一份主库，多处发布。",
    body: "~/SkillRepoTracker/skills 是来源中心；Claude Code、Codex 只是发布目标。",
    caption: "一份主库，多处发布",
    kind: "library",
  },
  {
    start: seconds(78),
    duration: seconds(14),
    eyebrow: "Skill Repo Tracker v1.1.6",
    title: "看清、备份、再行动。",
    body: "失败就是失败，不伪装成 0 Skills / 0 Plugins 的假空白。",
    caption: "失败就是失败，看清、备份、再行动",
    kind: "close",
  },
];

const appear = (frame: number, start: number, duration: number) => {
  const fade = seconds(0.55);
  const enter = interpolate(frame, [start, start + fade], [0, 1], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const exit = interpolate(frame, [start + duration - fade, start + duration], [1, 0], {
    easing: Easing.in(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return Math.min(enter, exit);
};

const sceneProgress = (frame: number, scene: Scene) =>
  interpolate(frame, [scene.start, scene.start + scene.duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

const chipStyle = (index: number, progress: number) => ({
  opacity: interpolate(progress, [0.05 + index * 0.08, 0.22 + index * 0.08], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  }),
  transform: `translateY(${interpolate(progress, [0, 0.45], [34 - index * 6, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })}px)`,
});

const Frame = ({ scene }: { scene: Scene }) => {
  const frame = useCurrentFrame();
  const opacity = appear(frame, scene.start, scene.duration);
  const progress = sceneProgress(frame, scene);
  const translateY = interpolate(opacity, [0, 1], [30, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        opacity,
        transform: `translateY(${translateY}px)`,
        padding: "150px 88px 170px",
        color: "#f5efe3",
        background: "#0d1511",
      }}
    >
      <div style={styles.frameBorder} />
      <p style={styles.eyebrow}>{scene.eyebrow}</p>
      <h1 style={styles.title}>{scene.title}</h1>
      {scene.body ? <p style={styles.body}>{scene.body}</p> : null}
      <SceneVisual scene={scene} progress={progress} />
      <div style={styles.caption}>{scene.caption}</div>
    </AbsoluteFill>
  );
};

const SceneVisual = ({ scene, progress }: { scene: Scene; progress: number }) => {
  if (scene.kind === "screenshot") {
    return (
      <div style={styles.screenshotWrap}>
        <Img src={staticFile("app-screenshot.png")} style={styles.screenshot} />
      </div>
    );
  }

  if (scene.kind === "plugin") {
    return (
      <div style={styles.stack}>
        {["README / manifest", "插件页收拢", "复制命令"].map((item, index) => (
          <div key={item} style={{ ...styles.step, ...chipStyle(index, progress) }}>
            <span style={styles.stepNumber}>{index + 1}</span>
            <div style={styles.stepCopy}>
              <strong style={styles.stepTitle}>{item}</strong>
              <small style={styles.stepBody}>
                {index === 0 ? "发现 marketplace、CLI、单 Skill 入口" : index === 1 ? "关联来源仓库和 Skill" : "由你决定在哪里执行"}
              </small>
            </div>
          </div>
        ))}
        <div style={styles.twoPills}>
          <span>不是市场</span>
          <span>不是安装器</span>
        </div>
      </div>
    );
  }

  if (scene.kind === "library") {
    return (
      <div style={styles.cards}>
        {["本地主库", "发布目标", "更新前检查", "移除前备份"].map((item, index) => (
          <div key={item} style={{ ...styles.card, ...chipStyle(index, progress) }}>
            <strong>{item}</strong>
            <small>{index < 2 ? "边界清楚" : "风险留痕"}</small>
          </div>
        ))}
      </div>
    );
  }

  if (scene.kind === "close") {
    return (
      <div style={styles.logoLockup}>
        <div style={styles.textLogo}>S</div>
        <div>
          <strong style={styles.product}>Skill Repo Tracker</strong>
          <p style={styles.version}>v1.1.6</p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.chipField}>
      {["GitHub repo", "/plugin install", "Codex target", "backup record"].map((item, index) => (
        <span key={item} style={{ ...styles.floatingChip, ...chipStyle(index, progress) }}>
          {item}
        </span>
      ))}
    </div>
  );
};

export const Promo = () => {
  useVideoConfig();

  return (
    <AbsoluteFill style={{ background: "#0d1511" }}>
      <Audio src={staticFile("narration.wav")} volume={1} />
      {scenes.map((scene) => (
        <Frame key={scene.eyebrow} scene={scene} />
      ))}
    </AbsoluteFill>
  );
};

const styles: Record<string, CSSProperties> = {
  frameBorder: {
    position: "absolute",
    inset: 72,
    border: "1px solid rgba(245,239,227,0.08)",
  },
  eyebrow: {
    margin: 0,
    color: "#d8a84f",
    fontFamily: "Menlo, monospace",
    fontSize: 28,
    fontWeight: 800,
    textTransform: "uppercase",
  },
  title: {
    maxWidth: 880,
    margin: "54px 0 0",
    fontSize: 82,
    lineHeight: 1.08,
    fontWeight: 850,
    letterSpacing: 0,
  },
  body: {
    maxWidth: 800,
    margin: "34px 0 0",
    color: "#bdc6b9",
    fontSize: 36,
    lineHeight: 1.38,
  },
  caption: {
    position: "absolute",
    left: 260,
    right: 260,
    bottom: 68,
    padding: "18px 24px",
    border: "1px solid rgba(245,239,227,0.14)",
    borderRadius: 10,
    color: "#f5efe3",
    background: "rgba(13,21,17,0.7)",
    fontSize: 30,
    fontWeight: 800,
    textAlign: "center",
  },
  chipField: {
    position: "relative",
    minHeight: 510,
    marginTop: 90,
  },
  floatingChip: {
    display: "inline-flex",
    margin: 18,
    padding: "24px 28px",
    border: "1px solid rgba(245,239,227,0.18)",
    borderRadius: 18,
    background: "rgba(22,37,29,0.82)",
    color: "#f5efe3",
    fontFamily: "Menlo, monospace",
    fontSize: 32,
    fontWeight: 800,
  },
  screenshotWrap: {
    marginTop: 64,
    padding: 18,
    border: "1px solid rgba(245,239,227,0.14)",
    borderRadius: 20,
    background: "#16251d",
    boxShadow: "0 24px 80px rgba(0,0,0,0.34)",
  },
  screenshot: {
    width: "100%",
    borderRadius: 12,
  },
  stack: {
    display: "grid",
    gap: 22,
    marginTop: 68,
  },
  step: {
    display: "grid",
    gridTemplateColumns: "74px 1fr",
    columnGap: 24,
    alignItems: "center",
    minHeight: 118,
    padding: "24px 28px",
    border: "1px solid rgba(245,239,227,0.15)",
    borderRadius: 14,
    background: "rgba(22,37,29,0.82)",
  },
  stepNumber: {
    display: "grid",
    placeItems: "center",
    width: 64,
    height: 64,
    borderRadius: 18,
    color: "#d8a84f",
    background: "rgba(216,168,79,0.14)",
    fontFamily: "Menlo, monospace",
    fontSize: 30,
    fontWeight: 900,
  },
  stepCopy: {
    display: "grid",
    gap: 8,
    minWidth: 0,
  },
  stepTitle: {
    fontSize: 33,
    lineHeight: 1.1,
  },
  stepBody: {
    color: "#bdc6b9",
    fontSize: 28,
    lineHeight: 1.3,
  },
  twoPills: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 18,
    marginTop: 18,
  },
  cards: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 22,
    marginTop: 76,
  },
  card: {
    minHeight: 168,
    padding: 28,
    border: "1px solid rgba(245,239,227,0.15)",
    borderRadius: 14,
    background: "rgba(22,37,29,0.82)",
  },
  logoLockup: {
    display: "flex",
    alignItems: "center",
    gap: 28,
    marginTop: 90,
  },
  textLogo: {
    display: "grid",
    placeItems: "center",
    width: 112,
    height: 112,
    border: "2px solid rgba(216,168,79,0.72)",
    borderRadius: 24,
    color: "#d8a84f",
    fontSize: 56,
    fontWeight: 900,
  },
  product: {
    fontSize: 44,
    lineHeight: 1,
  },
  version: {
    margin: "8px 0 0",
    color: "#d8a84f",
    fontFamily: "Menlo, monospace",
    fontSize: 26,
    fontWeight: 800,
  },
};
