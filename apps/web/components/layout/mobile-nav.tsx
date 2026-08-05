'use client';

import * as React from 'react';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { SidebarBrand } from './sidebar-brand';
import { SidebarNav } from './sidebar-nav';

export function MobileNav({ isSuperAdmin = false }: { isSuperAdmin?: boolean }) {
  const [open, setOpen] = React.useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          aria-label="Open navigation menu"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="flex flex-col p-0">
        {/*
          The dialog's accessible name/description live in dedicated sr-only
          nodes so Radix's generated ids stay attached to real elements.
        */}
        <SheetTitle className="sr-only">Navigation menu</SheetTitle>
        <SheetDescription className="sr-only">
          Primary application navigation
        </SheetDescription>
        <div className="flex h-16 shrink-0 items-center border-b border-sidebar-border px-4">
          <SidebarBrand />
        </div>
        <SidebarNav onNavigate={() => setOpen(false)} isSuperAdmin={isSuperAdmin} />
      </SheetContent>
    </Sheet>
  );
}
