import { render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KeptTimelines, useKeptTimelines } from "@/components/chat/keptTimelines";

const mounts: string[] = [];
const unmounts: string[] = [];

function Timeline({ id, paused, embed = false }: { id: string; paused?: boolean; embed?: boolean }) {
  const [mountedAs] = useState(id);
  useEffect(() => {
    mounts.push(mountedAs);
    return () => void unmounts.push(mountedAs);
  }, [mountedAs]);
  return (
    <div data-testid={`tl-${id}`} data-paused={paused ? "1" : "0"}>
      <video data-testid={`video-${id}`} />
      {embed && <iframe title={id} />}
    </div>
  );
}

function Page({ channel, embeds = [] }: { channel: string; embeds?: string[] }) {
  const live = <Timeline key={channel} id={channel} embed={embeds.includes(channel)} />;
  const timelines = useKeptTimelines(channel, live, () => undefined);
  return (
    <KeptTimelines active={channel} timelines={timelines}>
      {live}
    </KeptTimelines>
  );
}

describe("KeptTimelines", () => {
  let pause: { mock: { contexts: unknown[] } };
  beforeEach(() => {
    mounts.length = unmounts.length = 0;
    pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps a left channel mounted, paused and hidden, and shows it again without remounting", () => {
    const { rerender, getByTestId } = render(<Page channel="a" />);
    rerender(<Page channel="b" />);
    expect(getByTestId("tl-a").dataset.paused).toBe("1");
    expect(getByTestId("tl-a").parentElement!.className).toContain("content-visibility:hidden");
    expect(getByTestId("tl-b").dataset.paused).toBe("0");
    rerender(<Page channel="a" />);
    expect(getByTestId("tl-a").dataset.paused).toBe("0");
    expect(getByTestId("tl-a").parentElement!.className).not.toContain("content-visibility");
    expect(mounts).toEqual(["a", "b"]);
    expect(unmounts).toEqual([]);
  });

  it("unmounts the least recently shown channel past three", () => {
    const { rerender, queryByTestId } = render(<Page channel="a" />);
    for (const c of ["b", "c", "a", "d"]) rerender(<Page channel={c} />);
    expect(unmounts).toEqual(["b"]);
    expect(queryByTestId("tl-b")).toBeNull();
    expect(queryByTestId("tl-a")).not.toBeNull();
  });

  it("pauses a hidden channel's media", () => {
    const { rerender, getByTestId } = render(<Page channel="a" />);
    const video = getByTestId("video-a");
    rerender(<Page channel="b" />);
    expect(pause.mock.contexts).toContain(video);
  });

  it("unmounts a channel holding an embed when it is hidden, since an embed can't be paused", () => {
    const { rerender, queryByTestId } = render(<Page channel="a" embeds={["a"]} />);
    rerender(<Page channel="b" embeds={["a"]} />);
    expect(queryByTestId("tl-a")).toBeNull();
    expect(unmounts).toEqual(["a"]);
  });
});
