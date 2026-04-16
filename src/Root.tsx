import { Composition } from "remotion";
import { Project } from "./Project";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Project"
        component={Project}
        durationInFrames={120}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="BarLineChart"
        component={Project}
        durationInFrames={120}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
