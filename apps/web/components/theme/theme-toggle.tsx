'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Light/dark switch.
 *
 * The `.dark` class and a full set of dark tokens already existed in
 * `globals.css`; nothing in the app ever applied the class, so all of it was
 * dead CSS. This is what makes it reachable.
 *
 * Reads the DOM rather than storage for its initial value, because
 * `ThemeScript` has already resolved the OS preference by the time this
 * mounts — asking localStorage again would report "light" for a dark-mode
 * user who has never toggled it manually.
 */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
    setMounted(true);
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light');
    } catch {
      // Site data blocked: the toggle still works for this page load.
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      // Rendered but inert until mounted, so the button does not shift into
      // place after hydration.
      aria-label={mounted ? (dark ? 'Switch to light theme' : 'Switch to dark theme') : 'Theme'}
    >
      {mounted && dark ? (
        <Sun className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Moon className="h-4 w-4" aria-hidden="true" />
      )}
    </Button>
  );
}
