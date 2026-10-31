import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";
import tailwindcssAnimate from "tailwindcss-animate";
import typography from "@tailwindcss/typography";

/** A length times the Text size setting (`--font-scale`, `lib/fontScale.ts`); only font sizes use it. */
const scaled = (length: string) => `calc(${length} * var(--font-scale, 1))`;

export default {
	content: [
		"./pages/**/*.{ts,tsx}",
		"./components/**/*.{ts,tsx}",
		"./app/**/*.{ts,tsx}",
		"./src/**/*.{ts,tsx}",
	],
	prefix: "",
	theme: {
		container: {
			center: true,
			padding: '2rem',
			screens: {
				'2xl': '1400px'
			}
		},
		screens: {
			'sm': '640px',
			'sidebar': '900px',
			'md': '768px',
			'lg': '1024px',
			// The chat thread panel switches from a full-pane overlay slide to a
			// side-by-side 23rem push only here: at the `sidebar` width (900px)
			// the desktop rail + channel list already claim ~360px, so a 368px
			// side panel would crush the message column to a phone-width sliver.
			'thread': '1200px',
			'xl': '1280px',
			'2xl': '1536px',
		},
		extend: {
			spacing: {
				'22': '5.5rem',
				// The layout grid's one gutter (see `--gutter` in index.css).
				'gutter': 'var(--gutter)',
				'stack': 'var(--stack)',
			},
			// Tailwind's defaults (size, line height) scaled; below `xs`, dense chat
			// chrome. `chat` is message body text; `monogram` is avatar initials,
			// unscaled so it fits the avatar.
			fontSize: {
				xs: [scaled('0.75rem'), scaled('1rem')],
				sm: [scaled('0.875rem'), scaled('1.25rem')],
				base: [scaled('1rem'), scaled('1.5rem')],
				lg: [scaled('1.125rem'), scaled('1.75rem')],
				xl: [scaled('1.25rem'), scaled('1.75rem')],
				'2xl': [scaled('1.5rem'), scaled('2rem')],
				'3xl': [scaled('1.875rem'), scaled('2.25rem')],
				'4xl': [scaled('2.25rem'), scaled('2.5rem')],
				'chat': scaled('15px'),
				'2xs': scaled('11px'),
				'3xs': scaled('10px'),
				'monogram': '9px',
			},
			fontFamily: {
				// `--theme-font` is the active theme's font (AppProvider's ThemeFontSync).
				sans: ['var(--theme-font, "Inter Variable")', 'Inter Variable', 'Inter', 'system-ui', 'var(--emoji-fonts)', 'sans-serif'],
				// Display names: the theme's name font, else the body font.
				name: ['var(--theme-name-font, var(--theme-font, "Inter Variable"))', 'Inter Variable', 'Inter', 'system-ui', 'var(--emoji-fonts)', 'sans-serif'],
				emoji: ['var(--emoji-fonts)', 'EmojiSymbols', 'sans-serif'],
			},
			colors: {
				border: 'hsl(var(--border))',
				input: 'hsl(var(--input))',
				ring: 'hsl(var(--ring))',
				background: 'hsl(var(--background))',
				foreground: 'hsl(var(--foreground))',
				primary: {
					DEFAULT: 'hsl(var(--primary))',
					foreground: 'hsl(var(--primary-foreground))'
				},
				secondary: {
					DEFAULT: 'hsl(var(--secondary))',
					foreground: 'hsl(var(--secondary-foreground))'
				},
				destructive: {
					DEFAULT: 'hsl(var(--destructive))',
					foreground: 'hsl(var(--destructive-foreground))'
				},
				success: {
					DEFAULT: 'hsl(var(--success))',
					foreground: 'hsl(var(--success-foreground))'
				},
				warning: {
					DEFAULT: 'hsl(var(--warning))',
					foreground: 'hsl(var(--warning-foreground))'
				},
				muted: {
					DEFAULT: 'hsl(var(--muted))',
					foreground: 'hsl(var(--muted-foreground))'
				},
				accent: {
					DEFAULT: 'hsl(var(--accent))',
					foreground: 'hsl(var(--accent-foreground))'
				},
				accent2: 'hsl(var(--accent2))',
				popover: {
					DEFAULT: 'hsl(var(--popover))',
					foreground: 'hsl(var(--popover-foreground))'
				},
				card: {
					DEFAULT: 'hsl(var(--card))',
					foreground: 'hsl(var(--card-foreground))'
				}
			},
			borderRadius: {
				lg: 'var(--radius)',
				md: 'calc(var(--radius) - 2px)',
				sm: 'calc(var(--radius) - 4px)',
				xs: 'calc(var(--radius) - 8px)',
				chrome: 'var(--radius-chrome)'
			},
			keyframes: {
				'accordion-down': {
					from: {
						height: '0'
					},
					to: {
						height: 'var(--radix-accordion-content-height)'
					}
				},
				'accordion-up': {
					from: {
						height: 'var(--radix-accordion-content-height)'
					},
					to: {
						height: '0'
					}
				},
				'pending-glow': {
					'0%, 100%': {
						boxShadow: '0 0 0 0 hsl(var(--primary) / 0)'
					},
					'50%': {
						boxShadow: '0 0 8px 2px hsl(var(--primary) / 0.15)'
					}
				},
			'badge-spotlight': {
				from: { transform: 'rotate(0deg)' },
				to: { transform: 'rotate(360deg)' }
			},
			'highlight-fade': {
				from: { backgroundColor: 'hsl(var(--primary) / 0.10)' },
				to: { backgroundColor: 'transparent' }
			},
			'collapsible-down': {
				from: { height: '0' },
				to: { height: 'var(--radix-collapsible-content-height)' }
			},
			'collapsible-up': {
				from: { height: 'var(--radix-collapsible-content-height)' },
				to: { height: '0' }
			},
			'equaliser-bar': {
				// Vertical bounce for the bird-song play button's
				// inline equaliser. Bars share this keyframe and
				// stagger via animationDelay so the group reads as
				// an organic audio indicator.
				'0%, 100%': { transform: 'scaleY(0.35)' },
				'50%': { transform: 'scaleY(1)' }
			},
			'success-pop': {
				// Celebratory pop-in for the zap success checkmark.
				'0%': { transform: 'scale(0.3)', opacity: '0' },
				'60%': { transform: 'scale(1.15)', opacity: '1' },
				'100%': { transform: 'scale(1)', opacity: '1' }
			},
			'success-fade-up': {
				// Staggered fade-in from below for the body text + actions.
				'0%': { transform: 'translateY(8px)', opacity: '0' },
				'100%': { transform: 'translateY(0)', opacity: '1' }
			},
			'typing-dot': {
				// Signal-style typing pill: each dot swells + brightens in
				// sequence (staggered via animationDelay), resting dim for
				// the back half of the cycle.
				'0%, 44%, 100%': { transform: 'scale(1)', opacity: '0.35' },
				'22%': { transform: 'scale(1.3)', opacity: '1' }
			},
			'reaction-rise': {
				// In-call emoji reaction (à la Jitsi/Zoom): pops in over the
				// sender's tile and rises above the whole call stage, so
				// everyone sees it — not just whoever's looking at that tile.
				// `--rise` (px) is the SAME fixed distance for every reaction
				// in a given stage box, so no one's reaction gets more or
				// less screen time depending on where their tile sits. -50% X
				// keeps it centered on its jittered horizontal offset.
				'0%': { transform: 'translate(-50%, 0) scale(0.5)', opacity: '0' },
				'10%': { transform: 'translate(-50%, calc(var(--rise, 300px) * -0.12)) scale(1.15)', opacity: '1' },
				'25%': { transform: 'translate(-50%, calc(var(--rise, 300px) * -0.3)) scale(1)', opacity: '1' },
				'85%': { transform: 'translate(-50%, calc(var(--rise, 300px) * -0.92)) scale(1)', opacity: '1' },
				'100%': { transform: 'translate(-50%, calc(var(--rise, 300px) * -1)) scale(1)', opacity: '0' }
			},
			'ultra-shimmer': {
				// Armada Ultra name styles: the gradient drifts along the name.
				from: { backgroundPosition: '0% center' },
				to: { backgroundPosition: '200% center' }
			},
			'ultra-float': {
				// Armada Ultra profile effects: a particle pops in and drifts up.
				'0%': { transform: 'translateY(0) scale(0.4)', opacity: '0' },
				'20%': { transform: 'translateY(-15%) scale(1)', opacity: '1' },
				'100%': { transform: 'translateY(var(--float, -120px)) scale(0.8)', opacity: '0' }
			}
			},
			animation: {
				'accordion-down': 'accordion-down 0.2s ease-out',
				'accordion-up': 'accordion-up 0.2s ease-out',
				'pending-glow': 'pending-glow 2.5s ease-in-out infinite',
				'badge-spotlight': 'badge-spotlight 8s linear infinite',
				'highlight-fade': 'highlight-fade 1.5s ease-out forwards',
				'collapsible-down': 'collapsible-down 0.2s ease-out',
				'collapsible-up': 'collapsible-up 0.2s ease-out',
				'equaliser-bar': 'equaliser-bar 0.9s ease-in-out infinite',
				'success-pop': 'success-pop 0.55s cubic-bezier(0.34, 1.56, 0.64, 1) both',
				'success-fade-up': 'success-fade-up 0.45s ease-out both',
				'typing-dot': 'typing-dot 1.2s ease-in-out infinite',
				'reaction-rise': 'reaction-rise 4s ease-out forwards',
				'ultra-shimmer': 'ultra-shimmer 4s linear infinite',
				'ultra-float': 'ultra-float 2.4s ease-out both'
			}
		}
	},
	plugins: [
		tailwindcssAnimate,
		typography,
		// `fullscreen:` variant — targets an element while it is the fullscreen element.
		plugin(({ addVariant }) => {
			addVariant('fullscreen', '&:fullscreen');
			// `touch:` — touch-first devices (coarse primary pointer). Use this
			// instead of width breakpoints to gate tap-reveal / fat-finger guards,
			// so a merely narrow *desktop* window keeps hover + clickable controls.
			// Not `hover: none` too: some Android WebViews report hover on a phone.
			addVariant('touch', '@media (pointer: coarse)');
		}),
	],
} satisfies Config;
