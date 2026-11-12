import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Pipeline · 工具管理与组合执行', description: '管理自定义 Function 工具，通过 HTTP 和 MCP 供外部 Agent 调用，组合执行并记录共享上下文与资源。', icons: { icon: '/favicon.svg' } };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="zh-CN"><body>{children}</body></html>; }
