# LangChain으로 로컬 에이전트 만들기

Ollama가 설치되어 있다고 가정한다. 도구 호출을 지원하는 모델을 사용한다.

## 1. 준비

```bash
ollama pull gpt-oss:20b
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -U langchain langgraph langchain-ollama
```

## 2. 모델만 호출

```python
from langchain_ollama import ChatOllama

model = ChatOllama(model="gpt-oss:20b", temperature=0)
answer = model.invoke("15와 27을 더해 줘.")
print(answer.content)
```

이 단계의 모델은 답변만 생성하며, Python 함수를 직접 실행하지는 않는다.

## 3. 도구를 직접 연결

```python
from langchain.tools import tool
from langchain.messages import HumanMessage, ToolMessage

@tool
def add(a: int, b: int) -> int:
    """두 정수를 더한다."""
    return a + b

tools = {add.name: add}
model_with_tools = model.bind_tools(list(tools.values()))

messages = [HumanMessage("15와 27을 도구로 더해 줘.")]
response = model_with_tools.invoke(messages)
messages.append(response)

for call in response.tool_calls:
    result = tools[call["name"]].invoke(call["args"])
    messages.append(ToolMessage(content=str(result), tool_call_id=call["id"]))

final = model_with_tools.invoke(messages)
print(final.content)
```

직접 구현해야 하는 흐름은 `모델 호출 → 도구 선택 확인 → 함수 실행 → 결과 전달 → 모델 재호출`이다. 여러 번 도구를 쓰게 하려면 이 부분을 반복문으로 확장해야 한다.

## 4. 메시지 클래스의 흐름

```text
messages[0] HumanMessage     사용자: "15와 27을 더해 줘."
    ↓ 모델 호출
messages[1] AIMessage        모델: add(a=15, b=27)를 호출해 달라는 tool_calls 포함
    ↓ 프로그램이 add 실행
messages[2] ToolMessage      도구 결과: "42" (해당 tool_call_id 포함)
    ↓ ToolMessage까지 모델에 다시 전달
messages[3] AIMessage        모델의 최종 답변: "결과는 42입니다."
```

중요한 점은 도구 호출 요청이 별도 메시지가 아니라 첫 번째 `AIMessage`의 `tool_calls` 필드에 들어간다는 것이다.

```python
messages = [HumanMessage("15와 27을 더해 줘.")]

# HumanMessage를 보고 모델이 도구 호출을 요청한다.
ai_request = model_with_tools.invoke(messages)
messages.append(ai_request)       # AIMessage(tool_calls=[...])

# 프로그램이 도구를 실행하고 결과를 메시지로 추가한다.
tool_result = add.invoke({"a": 15, "b": 27})
messages.append(ToolMessage(
    content=str(tool_result),
    tool_call_id=ai_request.tool_calls[0]["id"],
))

# 모델은 HumanMessage, AIMessage, ToolMessage를 모두 보고 최종 답변한다.
ai_final = model_with_tools.invoke(messages)
messages.append(ai_final)         # AIMessage(content="결과는 42입니다.")
```

따라서 실행 도중 `state["messages"][-1]`은 가장 최근 메시지를 뜻한다. 모델 호출 직후에는 `AIMessage`, 도구 실행 직후에는 `ToolMessage`가 된다.

## 5. 조건부 간선으로 루프 만들기

먼저 조건을 직접 작성한다. 마지막 모델 응답에 `tool_calls`가 있으면 도구 노드로 가고, 없으면 종료한다.

```python
from langgraph.graph import END

def route_tools(state):
    last_message = state["messages"][-1]
    if last_message.tool_calls:
        return "tools"
    return END

builder.add_conditional_edges(
    "model",
    route_tools,
    {"tools": "tools", END: END},
)
```

흐름은 다음과 같다.

```text
model ── tool_calls 있음 ──> tools ──> model
  └──── tool_calls 없음 ──> END
```

## 6. `ToolNode`와 `tools_condition`으로 간소화

`ToolNode`는 도구 실행, `ToolMessage` 생성, 병렬 실행과 오류 처리를 맡는다. `tools_condition`은 모델이 도구를 요청하면 `tools`로, 아니면 종료로 보낸다.

```python
from langgraph.graph import StateGraph, MessagesState, START
from langgraph.prebuilt import ToolNode, tools_condition

model_with_tools = model.bind_tools([add])

def call_model(state: MessagesState):
    return {"messages": [model_with_tools.invoke(state["messages"])]}

builder = StateGraph(MessagesState)
builder.add_node("model", call_model)
builder.add_node("tools", ToolNode([add]))
builder.add_edge(START, "model")
builder.add_conditional_edges("model", tools_condition)  # route_tools를 대체
builder.add_edge("tools", "model")
graph = builder.compile()

result = graph.invoke({
    "messages": [{"role": "user", "content": "15와 27을 더해 줘."}]
})
print(result["messages"][-1].content)
```

즉, `tools_condition`은 앞 단계의 `route_tools`를 미리 구현해 둔 함수다. 수동 `for` 문은 없어졌지만 상태·노드·간선을 직접 구성하므로 실행 흐름을 세밀하게 바꿀 수 있다.

## 7. `create_agent`로 전체 구성 간소화

```python
from langchain.agents import create_agent

agent = create_agent(
    model=model,
    tools=[add],
    system_prompt="계산이 필요하면 반드시 도구를 사용하고 짧게 답하라.",
)

result = agent.invoke({
    "messages": [{"role": "user", "content": "15와 27을 더해 줘."}]
})
print(result["messages"][-1].content)
```

`create_agent`는 `CompiledStateGraph`를 만든다. 도구가 전달되면 내부의 `ToolNode`가 도구를 실행하고, 모델 응답에 `tool_calls`가 있는 동안 `모델 → 도구 → 모델` 흐름을 반복한다. 단, 앞에서 사용한 `tools_condition` 함수를 그대로 호출한다고 볼 필요는 없으며 `create_agent`가 자체 라우팅을 구성한다. 사용자 정의 분기가 필요하면 5~6단계처럼 LangGraph를 직접 구성한다.

> 모델이 도구를 호출하지 못하면 Ollama에서 도구 호출을 지원하는 모델인지 확인한다. 설치 모델은 `ollama list`로 볼 수 있다.

참고: [LangChain ChatOllama](https://docs.langchain.com/oss/python/integrations/chat/ollama), [ToolNode](https://docs.langchain.com/oss/python/langchain/tools#toolnode), [LangChain Agents](https://docs.langchain.com/oss/python/langchain/agents)
