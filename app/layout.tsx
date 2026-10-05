import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Omni · Your models, one conversation",
  description:
    "Private AI conversations with clear routing and shared history.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
