import * as React from "react"

import { cn } from "@/lib/utils"

export interface InputProps extends React.ComponentProps<"input"> {
  /** `bare` drops the well for an input inside one (a search bar, a composer row). */
  variant?: "field" | "bare"
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, variant = "field", ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 touch:h-11 w-full px-3 py-2 text-base file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          variant === "field" ? "field" : "bg-transparent",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
