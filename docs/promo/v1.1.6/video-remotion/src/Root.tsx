import { Composition } from "remotion";
import { Promo } from "./Promo";
import { VIDEO_DURATION_FRAMES, VIDEO_FPS, VIDEO_HEIGHT, VIDEO_WIDTH } from "./constants";

export const RemotionRoot = () => {
  return (
    <Composition
      id="SkillRepoTrackerV116"
      component={Promo}
      durationInFrames={VIDEO_DURATION_FRAMES}
      fps={VIDEO_FPS}
      width={VIDEO_WIDTH}
      height={VIDEO_HEIGHT}
    />
  );
};
