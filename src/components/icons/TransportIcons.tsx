import React from "react";

type IconProps = React.SVGProps<SVGSVGElement>;

const base = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** One hive cell branching out through a server: a call carried by an SFU (LiveKit). */
export const HubIcon = React.forwardRef<SVGSVGElement, IconProps>(({ strokeWidth = 2.5, ...props }, ref) => (
  <svg ref={ref} {...base} strokeWidth={strokeWidth} strokeLinecap="butt" strokeLinejoin="miter" {...props}>
    <polygon points="12,8.5 17.63,11.75 17.63,18.25 12,21.5 6.37,18.25 6.37,11.75" strokeWidth={2.25} />
    <circle cx="12" cy="15" r="2" fill="currentColor" stroke="none" />
    <path d="M9.2 10.1 6 4.6M14.8 10.1 18 4.6" />
  </svg>
));
HubIcon.displayName = "HubIcon";

/** Three linked cells: a peer-to-peer call (iroh, as Vector places them). */
export const HiveIcon = React.forwardRef<SVGSVGElement, IconProps>(({ strokeWidth = 2, ...props }, ref) => (
  <svg ref={ref} {...base} strokeWidth={strokeWidth} {...props}>
    <path d="M12 3.9 16 6.2v4.6l-4 2.3-4-2.3V6.2Z" />
    <path d="M8 10.8l4 2.3v4.6L8 20l-4-2.3v-4.6Z" />
    <path d="M16 10.8l4 2.3v4.6L16 20l-4-2.3v-4.6Z" />
    <circle cx="12" cy="8.5" r="1.25" fill="currentColor" stroke="none" />
    <circle cx="8" cy="15.4" r="1.25" fill="currentColor" stroke="none" />
    <circle cx="16" cy="15.4" r="1.25" fill="currentColor" stroke="none" />
  </svg>
));
HiveIcon.displayName = "HiveIcon";
