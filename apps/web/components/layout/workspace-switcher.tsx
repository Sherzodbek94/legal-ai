'use client';

import * as React from 'react';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { workspaces, type Workspace } from '@/lib/navigation';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function WorkspaceSwitcher() {
  const [active, setActive] = React.useState<Workspace>(workspaces[0]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          // aria-label carries the current selection so screen readers announce
          // state, not just the control name.
          aria-label={`Current workspace: ${active.name}. Switch workspace`}
          className="h-9 w-full max-w-[15rem] justify-between gap-2 px-3 font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-primary text-[0.625rem] font-semibold text-primary-foreground"
            >
              {active.name.charAt(0)}
            </span>
            <span className="truncate text-sm font-medium">{active.name}</span>
          </span>
          <ChevronsUpDown
            className="h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-[15rem]">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {workspaces.map((workspace) => {
          const isActive = workspace.id === active.id;
          return (
            <DropdownMenuItem
              key={workspace.id}
              onSelect={() => setActive(workspace)}
              className="gap-2"
            >
              <Check
                className={cn('h-4 w-4', isActive ? 'opacity-100' : 'opacity-0')}
                aria-hidden="true"
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm">{workspace.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {workspace.plan}
                </span>
              </span>
              {isActive && <span className="sr-only">(current)</span>}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2">
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span className="text-sm">Create workspace</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
