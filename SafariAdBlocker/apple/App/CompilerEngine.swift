// Runs the Bastion filter compiler (compiler/src, bundled as
// bastion-compiler.js) inside a hidden WKWebView. That gives it JIT-speed
// JavaScript in a separate process, so compiling hundreds of thousands of
// filters neither blocks the UI nor counts against the app's memory, and CSS
// selectors are validated by the same WebKit engine Safari uses.

import Foundation
import WebKit

enum CompilerError: LocalizedError {
    case missingCompiler
    case loadFailed(String)
    case badOutput

    var errorDescription: String? {
        switch self {
        case .missingCompiler: return "The filter compiler is missing from the app bundle."
        case .loadFailed(let reason): return "Could not start the filter compiler: \(reason)"
        case .badOutput: return "The filter compiler returned an unexpected result."
        }
    }
}

final class CompilerEngine: NSObject, WKNavigationDelegate {
    struct Output {
        let blockers: [BlockerSlot: String]
        let webIndex: String
        let report: String
    }

    private var webView: WKWebView?
    private var loadContinuation: CheckedContinuation<Void, Error>?

    /// - Parameter lists: [{id, text, category, trusted}]
    @MainActor
    func compile(lists: [[String: Any]]) async throws -> Output {
        let webView = try await prepare()
        let listsJSON = String(decoding: try JSONSerialization.data(withJSONObject: lists), as: UTF8.self)
        let options = #"{"useDOMSelectorValidation":true}"#
        let value: Any = try await withCheckedThrowingContinuation { continuation in
            webView.callAsyncJavaScript(
                "return BastionCompiler.buildJSON(lists, options);",
                arguments: ["lists": listsJSON, "options": options],
                in: nil,
                in: .page
            ) { result in
                continuation.resume(with: result)
            }
        }
        guard let dict = value as? [String: Any],
              let blockers = dict["blockers"] as? [String: String],
              let webIndex = dict["webIndex"] as? String,
              let report = dict["report"] as? String else {
            throw CompilerError.badOutput
        }
        var map: [BlockerSlot: String] = [:]
        for (key, json) in blockers {
            if let slot = BlockerSlot(rawValue: key) { map[slot] = json }
        }
        return Output(blockers: map, webIndex: webIndex, report: report)
    }

    /// Frees the web content process between updates.
    @MainActor
    func tearDown() {
        webView?.navigationDelegate = nil
        webView = nil
    }

    @MainActor
    private func prepare() async throws -> WKWebView {
        if let webView { return webView }
        guard let url = Bundle.main.url(forResource: "bastion-compiler", withExtension: "js"),
              let source = try? String(contentsOf: url, encoding: .utf8) else {
            throw CompilerError.missingCompiler
        }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addUserScript(
            WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 10, height: 10), configuration: configuration)
        webView.navigationDelegate = self
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            loadContinuation = continuation
            webView.loadHTMLString("<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>", baseURL: nil)
        }
        self.webView = webView
        return webView
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadContinuation?.resume()
        loadContinuation = nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        loadContinuation?.resume(throwing: CompilerError.loadFailed(error.localizedDescription))
        loadContinuation = nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loadContinuation?.resume(throwing: CompilerError.loadFailed(error.localizedDescription))
        loadContinuation = nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // Usually memory pressure; the next compile starts a fresh process.
        self.webView = nil
    }
}
