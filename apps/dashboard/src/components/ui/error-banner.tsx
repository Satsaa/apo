import * as React from "react"

import { cn } from "@/lib/utils"

function ErrorBanner({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="alert"
      data-slot="error-banner"
      className={cn(
        "border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive",
        className
      )}
      {...props}
    />
  )
}

export { ErrorBanner }
