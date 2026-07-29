import type { Metadata } from 'next';
import { SplitScreenEditor } from '@/components/editor/split-screen-editor';

export const metadata: Metadata = {
  title: 'Document Editor',
};

export default function DocumentsPage() {
  return (
    <SplitScreenEditor
      documentTitle="Mutual NDA — Northwind Systems"
      matterName="Matter 2026-0148 · Vendor onboarding"
    />
  );
}
