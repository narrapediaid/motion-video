import { Composition } from "remotion";
import { BarLineChart } from "./BarLineChart";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="BarLineChart"
        component={BarLineChart}
        durationInFrames={120}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
