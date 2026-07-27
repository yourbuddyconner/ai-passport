import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foil disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-muted text-accent-foreground hover:bg-accent',
        outline: 'border border-primary/40 bg-transparent text-card-foreground hover:bg-primary/10',
        destructive:
          'border border-destructive/40 bg-transparent text-destructive hover:bg-destructive/10 hover:border-destructive/70',
        ghost: 'text-foreground/80 hover:bg-white/10 hover:text-foreground',
        /* for buttons sitting on the dark cover backdrop */
        cover: 'border border-foil/40 bg-transparent text-foreground hover:bg-foil/10 hover:border-foil/70',
      },
      size: {
        default: 'h-10 px-5 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-12 rounded-md px-8 text-base',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
