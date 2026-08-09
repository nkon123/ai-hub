// Root error boundary (M04).
//
// Without this, an uncaught render/effect error (e.g. a screen touching a
// bridge method that doesn't exist) unmounts the entire React tree — a
// silent white screen with nothing in the UI explaining what happened.
// That's a direct violation of CLAUDE.md's "Desktop은 Runtime 장애 시 종료
// 되지 않고 복구 안내를 제공한다" and "Error 상태를 정상 흐름과 함께 구현
// 한다". React has no hook equivalent for catching render errors, so this
// has to be a class component.
//
// This is the last line of defense. Screens should still handle their own
// *expected* failures locally (missing bridge -> BridgeUnavailableState,
// rejected IPC calls -> inline ErrorBanner + retry) rather than relying on
// this boundary to catch them.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "./ui";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Diagnostics only: an error message + component stack, never prompt
    // text, document contents, or DB results (CLAUDE.md log rule).
    console.error("[ErrorBoundary] unhandled error in renderer", error, info.componentStack);
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <AlertTriangle size={36} className="text-danger" />
        <div>
          <h1 className="text-section-title font-bold text-text-primary">예기치 않은 오류가 발생했습니다</h1>
          <p className="mt-1 max-w-md text-body text-text-secondary">
            화면을 표시하는 중 문제가 발생했습니다. 다시 시도해도 계속되면 앱을 완전히 종료한 뒤 다시 실행해 주세요.
          </p>
        </div>
        <Button onClick={this.handleRetry}>
          <RefreshCw size={14} /> 다시 시도
        </Button>
        <details className="mt-2 w-full max-w-md rounded-lg border border-border bg-surface p-2 text-left">
          <summary className="cursor-pointer text-caption font-medium text-text-secondary">기술 정보 (진단용)</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-text-muted">
            {error.message}
          </pre>
        </details>
      </div>
    );
  }
}
