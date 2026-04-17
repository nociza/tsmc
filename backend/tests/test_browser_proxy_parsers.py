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


def test_chatgpt_parser_keeps_only_user_visible_active_path_messages() -> None:
    parser = PARSER_REGISTRY[ProviderName.CHATGPT]
    event = CapturedNetworkEvent(
        provider_hint=ProviderName.CHATGPT,
        page_url="https://chatgpt.com/c/current-session",
        request_id="req-chatgpt-current-1",
        method="GET",
        url="https://chatgpt.com/backend-api/conversation/current-session",
        captured_at="2026-04-16T18:00:00.000Z",
        request_body=None,
        response=CapturedResponse(
            status=200,
            ok=True,
            content_type="application/json",
            text="",
            json={
                "conversation_id": "current-session",
                "current_node": "reasoning-node",
                "mapping": {
                    "root": {"id": "root", "message": None, "parent": None},
                    "user-node": {
                        "id": "user-node",
                        "parent": "root",
                        "message": {
                            "id": "user-msg",
                            "author": {"role": "user"},
                            "create_time": 1776194532,
                            "content": {
                                "content_type": "multimodal_text",
                                "parts": [
                                    {
                                        "content_type": "image_asset_pointer",
                                        "asset_pointer": "sediment://file_00000000000000000000000000000000",
                                    },
                                    "What are the color codes?",
                                ],
                            },
                        },
                    },
                    "python-call": {
                        "id": "python-call",
                        "parent": "user-node",
                        "message": {
                            "id": "assistant-code",
                            "author": {"role": "assistant"},
                            "recipient": "python",
                            "create_time": 1776194533,
                            "content": {"content_type": "code", "parts": ["from PIL import Image"]},
                        },
                    },
                    "tool-output": {
                        "id": "tool-output",
                        "parent": "python-call",
                        "message": {
                            "id": "tool-output-msg",
                            "author": {"role": "tool", "name": "python"},
                            "create_time": 1776194534,
                            "content": {"content_type": "text", "parts": ["#008AFC"]},
                        },
                    },
                    "assistant-final": {
                        "id": "assistant-final",
                        "parent": "tool-output",
                        "message": {
                            "id": "assistant-msg",
                            "author": {"role": "assistant"},
                            "recipient": "all",
                            "channel": "final",
                            "create_time": 1776194535,
                            "metadata": {"parent_id": "user-msg"},
                            "content": {"content_type": "text", "parts": ["The colors are #008AFC and #44C3FD."]},
                        },
                    },
                    "reasoning-node": {
                        "id": "reasoning-node",
                        "parent": "assistant-final",
                        "message": {
                            "id": "reasoning-msg",
                            "author": {"role": "assistant"},
                            "recipient": "all",
                            "create_time": 1776194536,
                            "content": {"content_type": "reasoning_recap", "parts": ["Thought for 14s"]},
                        },
                    },
                    "alternate-branch": {
                        "id": "alternate-branch",
                        "parent": "user-node",
                        "message": {
                            "id": "alternate-msg",
                            "author": {"role": "assistant"},
                            "recipient": "all",
                            "create_time": 1776194537,
                            "content": {"content_type": "text", "parts": ["Discarded branch."]},
                        },
                    },
                },
            },
        ),
    )

    assert parser.matches(event) is True
    snapshot = parser.parse(event)

    assert snapshot is not None
    assert snapshot.external_session_id == "current-session"
    assert [message.id for message in snapshot.messages] == ["user-msg", "assistant-msg"]
    assert [message.content for message in snapshot.messages] == [
        "What are the color codes?",
        "The colors are #008AFC and #44C3FD.",
    ]
    assert snapshot.messages[1].parent_id == "user-msg"


def test_chatgpt_parser_captures_request_and_sse_response_messages() -> None:
    parser = PARSER_REGISTRY[ProviderName.CHATGPT]
    event = CapturedNetworkEvent(
        provider_hint=ProviderName.CHATGPT,
        page_url="https://chatgpt.com/c/stream-session",
        request_id="req-chatgpt-stream-1",
        method="POST",
        url="https://chatgpt.com/backend-api/conversation",
        captured_at="2026-04-16T18:00:00.000Z",
        request_body=CapturedBody(
            json={
                "conversation_id": "stream-session",
                "messages": [
                    {
                        "id": "request-user-msg",
                        "author": {"role": "user"},
                        "content": {"content_type": "text", "parts": ["Say hello."]},
                    }
                ],
            }
        ),
        response=CapturedResponse(
            status=200,
            ok=True,
            content_type="text/event-stream",
            text=(
                'data: {"conversation_id":"stream-session","message":{"id":"assistant-stream-msg",'
                '"author":{"role":"assistant"},"recipient":"all","metadata":{"parent_id":"request-user-msg"},'
                '"content":{"content_type":"text","parts":["Hello there."]}}}\n\n'
                "data: [DONE]\n"
            ),
            json=None,
        ),
    )

    assert parser.matches(event) is True
    snapshot = parser.parse(event)

    assert snapshot is not None
    assert snapshot.external_session_id == "stream-session"
    assert [message.content for message in snapshot.messages] == ["Say hello.", "Hello there."]
    assert snapshot.messages[1].parent_id == "request-user-msg"


def test_chatgpt_parser_rejects_history_lists_and_deceptive_hosts() -> None:
    parser = PARSER_REGISTRY[ProviderName.CHATGPT]
    list_event = CapturedNetworkEvent(
        provider_hint=ProviderName.CHATGPT,
        page_url="https://chatgpt.com/",
        request_id="req-chatgpt-list-1",
        method="GET",
        url="https://chatgpt.com/backend-api/conversations?offset=0&limit=100&order=updated",
        captured_at="2026-04-16T18:00:00.000Z",
        request_body=None,
        response=CapturedResponse(
            status=200,
            ok=True,
            content_type="application/json",
            text='{"items":[{"id":"listed-session","title":"Listed conversation"}]}',
            json={"items": [{"id": "listed-session", "title": "Listed conversation"}]},
        ),
    )
    deceptive_event = CapturedNetworkEvent(
        provider_hint=ProviderName.CHATGPT,
        page_url="https://chatgpt.com/",
        request_id="req-chatgpt-deceptive-1",
        method="GET",
        url="https://notchatgpt.com/backend-api/conversation/listed-session",
        captured_at="2026-04-16T18:00:00.000Z",
        request_body=None,
        response=list_event.response,
    )

    assert parser.matches(list_event) is False
    assert parser.parse(list_event) is None
    assert parser.matches(deceptive_event) is False
    assert parser.parse(deceptive_event) is None


def test_grok_parser_extracts_current_responses_array() -> None:
    parser = PARSER_REGISTRY[ProviderName.GROK]
    event = CapturedNetworkEvent(
        provider_hint=ProviderName.GROK,
        page_url="https://grok.com/c/grok-current-session",
        request_id="req-grok-current-1",
        method="GET",
        url="https://grok.com/rest/app-chat/conversations/grok-current-session/responses?includeThreads=true",
        captured_at="2026-04-16T18:00:00.000Z",
        request_body=None,
        response=CapturedResponse(
            status=200,
            ok=True,
            content_type="application/json",
            text='{"responses":[{"responseId":"grok-user-current","sender":"USER","query":"What changed in the Grok history API?","createTime":"2026-04-16T17:59:00.000Z"},{"responseId":"grok-assistant-current","sender":"ASSISTANT","message":"The history list returns conversations, while message details live under responses.","parentResponseId":"grok-user-current","createTime":"2026-04-16T17:59:03.000Z"}]}',
            json={
                "responses": [
                    {
                        "responseId": "grok-user-current",
                        "sender": "USER",
                        "query": "What changed in the Grok history API?",
                        "createTime": "2026-04-16T17:59:00.000Z",
                    },
                    {
                        "responseId": "grok-assistant-current",
                        "sender": "ASSISTANT",
                        "message": "The history list returns conversations, while message details live under responses.",
                        "parentResponseId": "grok-user-current",
                        "createTime": "2026-04-16T17:59:03.000Z",
                    },
                ]
            },
        ),
    )

    assert parser.matches(event) is True
    snapshot = parser.parse(event)

    assert snapshot is not None
    assert snapshot.external_session_id == "grok-current-session"
    assert [message.id for message in snapshot.messages] == ["grok-user-current", "grok-assistant-current"]
    assert [message.content for message in snapshot.messages] == [
        "What changed in the Grok history API?",
        "The history list returns conversations, while message details live under responses.",
    ]
    assert snapshot.messages[1].parent_id == "grok-user-current"


def test_grok_parser_rejects_history_list_payloads() -> None:
    parser = PARSER_REGISTRY[ProviderName.GROK]
    event = CapturedNetworkEvent(
        provider_hint=ProviderName.GROK,
        page_url="https://grok.com/",
        request_id="req-grok-list-1",
        method="GET",
        url="https://grok.com/rest/app-chat/conversations?pageSize=60",
        captured_at="2026-04-16T18:00:00.000Z",
        request_body=None,
        response=CapturedResponse(
            status=200,
            ok=True,
            content_type="application/json",
            text='{"conversations":[{"conversationId":"grok-list-session","title":"A listed conversation"}]}',
            json={
                "conversations": [
                    {
                        "conversationId": "grok-list-session",
                        "title": "A listed conversation",
                    }
                ]
            },
        ),
    )

    assert parser.matches(event) is False
    assert parser.parse(event) is None


def test_grok_parser_rejects_x_timeline_payloads() -> None:
    parser = PARSER_REGISTRY[ProviderName.GROK]
    event = CapturedNetworkEvent(
        provider_hint=ProviderName.GROK,
        page_url="https://x.com/home",
        request_id="req-x-timeline-1",
        method="GET",
        url="https://x.com/i/api/graphql/Yf4WJo0fW46TnqrHUw_1Ow/HomeTimeline",
        captured_at="2026-04-16T18:00:00.000Z",
        request_body=None,
        response=CapturedResponse(
            status=200,
            ok=True,
            content_type="application/json",
            text='{"data":{"home":{"timeline":"not a Grok chat"}}}',
            json={"data": {"home": {"timeline": "not a Grok chat"}}},
        ),
    )

    assert parser.matches(event) is False
    assert parser.parse(event) is None
