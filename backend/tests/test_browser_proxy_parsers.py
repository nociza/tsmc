from __future__ import annotations

import pytest

from app.models import ProviderName
from app.services.browser_proxy.parsers import PARSER_REGISTRY
from app.services.browser_proxy.types import CapturedBody, CapturedNetworkEvent, CapturedResponse


@pytest.mark.parametrize(
    ("provider", "event", "expected_session_id", "expected_message_ids"),
    [
        (
            ProviderName.CHATGPT,
            CapturedNetworkEvent(
                provider_hint=ProviderName.CHATGPT,
                page_url="https://chatgpt.com/c/chatgpt-session-1",
                request_id="req-chatgpt-1",
                method="GET",
                url="https://chatgpt.com/backend-api/conversation/chatgpt-session-1",
                captured_at="2026-04-02T12:00:00.000Z",
                request_body=None,
                response=CapturedResponse(
                    status=200,
                    ok=True,
                    content_type="application/json",
                    text='{"conversation_id":"chatgpt-session-1","title":"ChatGPT Proxy Test","mapping":{"node-1":{"id":"node-1","message":{"id":"msg-user-1","author":{"role":"user"},"content":{"parts":["Explain the proxy flow."]}}},"node-2":{"parent":"msg-user-1","message":{"id":"msg-assistant-1","author":{"role":"assistant"},"content":{"parts":["The proxy uses the logged-in browser UI."]}}}}}',
                    json={
                        "conversation_id": "chatgpt-session-1",
                        "title": "ChatGPT Proxy Test",
                        "mapping": {
                            "node-1": {
                                "id": "node-1",
                                "message": {
                                    "id": "msg-user-1",
                                    "author": {"role": "user"},
                                    "content": {"parts": ["Explain the proxy flow."]},
                                },
                            },
                            "node-2": {
                                "parent": "msg-user-1",
                                "message": {
                                    "id": "msg-assistant-1",
                                    "author": {"role": "assistant"},
                                    "content": {"parts": ["The proxy uses the logged-in browser UI."]},
                                },
                            },
                        },
                    },
                ),
            ),
            "chatgpt-session-1",
            ["msg-user-1", "msg-assistant-1"],
        ),
        (
            ProviderName.GEMINI,
            CapturedNetworkEvent(
                provider_hint=ProviderName.GEMINI,
                page_url="https://gemini.google.com/u/1/app/gemini-session-1",
                request_id="req-gemini-1",
                method="POST",
                url="https://gemini.google.com/u/1/_/BardChatUi/data/batchexecute?rpcids=hNvQHb",
                captured_at="2026-04-02T12:00:00.000Z",
                request_body=CapturedBody(text="f.req=%5B%5D", json=None),
                response=CapturedResponse(
                    status=200,
                    ok=True,
                    content_type="application/json",
                    text='{"conversationId":"c_gemini-session-1","messages":[{"id":"msg-user-1","role":"user","content":"Explain the proxy flow."},{"id":"msg-assistant-1","role":"assistant","content":"The proxy uses the logged-in browser UI.","parentId":"msg-user-1"}]}',
                    json={
                        "conversationId": "c_gemini-session-1",
                        "messages": [
                            {"id": "msg-user-1", "role": "user", "content": "Explain the proxy flow."},
                            {
                                "id": "msg-assistant-1",
                                "role": "assistant",
                                "content": "The proxy uses the logged-in browser UI.",
                                "parentId": "msg-user-1",
                            },
                        ],
                    },
                ),
            ),
            "u1__gemini-session-1",
            ["msg-user-1", "msg-assistant-1"],
        ),
        (
            ProviderName.GROK,
            CapturedNetworkEvent(
                provider_hint=ProviderName.GROK,
                page_url="https://grok.com/c/grok-session-1",
                request_id="req-grok-1",
                method="GET",
                url="https://grok.com/rest/app-chat/conversations/grok-session-1/responses?includeThreads=true",
                captured_at="2026-04-02T12:00:00.000Z",
                request_body=None,
                response=CapturedResponse(
                    status=200,
                    ok=True,
                    content_type="application/json",
                    text='{"conversationId":"grok-session-1","title":"Grok Proxy Test","messages":[{"id":"msg-user-1","role":"user","content":"Explain the proxy flow."},{"id":"msg-assistant-1","role":"assistant","content":"The proxy uses the logged-in browser UI.","parentId":"msg-user-1"}]}',
                    json={
                        "conversationId": "grok-session-1",
                        "title": "Grok Proxy Test",
                        "messages": [
                            {"id": "msg-user-1", "role": "user", "content": "Explain the proxy flow."},
                            {
                                "id": "msg-assistant-1",
                                "role": "assistant",
                                "content": "The proxy uses the logged-in browser UI.",
                                "parentId": "msg-user-1",
                            },
                        ],
                    },
                ),
            ),
            "grok-session-1",
            ["msg-user-1", "msg-assistant-1"],
        ),
    ],
)
def test_provider_parsers_extract_messages_for_all_supported_providers(
    provider: ProviderName,
    event: CapturedNetworkEvent,
    expected_session_id: str,
    expected_message_ids: list[str],
) -> None:
    parser = PARSER_REGISTRY[provider]
    assert parser.matches(event) is True

    snapshot = parser.parse(event)

    assert snapshot is not None
    assert snapshot.external_session_id == expected_session_id
    assert [message.id for message in snapshot.messages] == expected_message_ids
