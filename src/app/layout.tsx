import type { Metadata } from "next";
import "./globals.css";
import "./saas.css";
export const metadata: Metadata = { title: "FLSD Management System", description: "FLSD Transport Services Corporation — internal management application" };
export default function RootLayout({ children }: Readonly<{children: React.ReactNode}>) {
 return <html lang="en"><body>{children}</body></html>;
}
