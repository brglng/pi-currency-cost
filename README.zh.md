# @brglng/pi-currency-cost

> 英文版见 [README.md](README.md)。

一个 [Pi coding agent](https://pi.dev/) 扩展：在每条最终确定的 assistant
消息上，把已配置 Provider/模型的用量费用换成 USD，让所有费用和合计都以
同一种货币显示——即使不同的 Provider 用不同的币种计费。

## 安装

```bash
pi install npm:@brglng/pi-currency-cost
```

## 配置

### 在 Pi 的 settings.json 中配置汇率

将 `pi-currency-cost` 命名空间添加到 Pi 的全局 `<agentDir>/settings.json`
（默认为 `~/.pi/agent/settings.json`）。请使用严格的 JSON，不要添加注释或
尾随逗号。扩展会忽略项目设置和 `models.json` 中的此命名空间。

```json
{
  "pi-currency-cost": {
    "currencies": {
      "CNY": { "usdRate": 0.147 }
    },
    "exchangeRateSource": { "type": "frankfurter" }
  }
}
```

此处有效的汇率及汇率来源设置优先于合并后的旧版配置。

从 0.2.0 升级时，请在 `settings.json` 中将 `currencyExchangeRateSource`
改为 `exchangeRateSource`。扩展会忽略旧键。

### 在 Pi 的 models.json 中声明 Provider 和模型的币种

在 Pi 的全局 `<agentDir>/models.json` 中，将 `currency` 写在对应的 Provider
或模型定义中。请将以下字段合并到现有配置中；示例省略了 Pi 为自定义模型
所需的其他字段。

```json
{
  "providers": {
    "bailian": {
      "currency": "CNY",
      "models": [
        { "id": "custom-usd-model", "currency": "USD" }
      ]
    },
    "openrouter": {
      "modelOverrides": {
        "some-model-id": { "currency": "CNY" }
      }
    }
  }
}
```

币种优先级为**内联模型 → 内联 Provider → 旧版模型 → 旧版 Provider**。
对同一模型 ID，`modelOverrides` 中有效的币种优先于 `models` 中的币种。
使用 `USD` 可让模型费用保持原样。内联值缺失或无效时，使用下一级适用设置。

### 旧版配置文件

扩展仍读取两份可选的 JSON 配置文件并把它们合并，其中项目配置优先于全局配置：

- 全局：`~/.pi/agent/extensions/pi-currency-cost/config.json`
- 项目：`<cwd>/.pi/extensions/pi-currency-cost/config.json`

```json
{
  "currencies": {
    "CNY": { "usdRate": 0.147 }
  },
  "providers": {
    "bailian": { "currency": "CNY" }
  },
  "rateSource": { "type": "frankfurter" }
}
```

可直接修改的模板见
[`config/config.example.json`](config/config.example.json)。

### currencies

所有汇率都是“1 单位源币种兑换多少 USD”（例如 1 CNY = 0.147 USD）。每个
配置的非 USD 币种都必须提供 `usdRate`——一个正的、有限的数字——才能被
换算。`usdRate` 是唯一必填字段，没有它就不会转换：

```json
{
  "currencies": {
    "CNY": { "usdRate": 0.147 },
    "EUR": { "usdRate": 1.083 }
  }
}
```

`usdRate` 就是换算时使用的汇率。当扩展取到新汇率时，会写回这个字段（并
同时更新 `updatedAt`）。

### providers

只有列在这里的 Provider 才会被换算；没列出的 Provider 保持原样。每一项声明
Pi 报告该 Provider 用量费用所用的币种，也可以在此基础上叠加按模型覆盖：

```json
{
  "providers": {
    "bailian": { "currency": "CNY" },
    "my-gateway": {
      "currency": "EUR",
      "models": {
        "euro-model": { "currency": "EUR" },
        "usd-model": { "currency": "USD" }
      }
    }
  }
}
```

币种为 `USD` 的 Provider（以及没有列出的 Provider）一律不做转换。未设置
覆盖的模型使用其 Provider 的币种。

### rateSource

默认是较通用的 Frankfurter 参考汇率服务：

```json
{
  "rateSource": {
    "type": "frankfurter"
  }
}
```

如果更偏好面向中国大陆环境的来源，也可以选择中国银行：

```json
{
  "rateSource": {
    "type": "boc"
  }
}
```

两个内置来源都使用有界超时。

## 命令

- `/currency-cost status` 显示配置路径、当前汇率来源、每种币种的汇率
  （含更新时间）以及 Provider/模型与币种的对应关系。
- `/currency-cost refresh` 为所有配置的非 USD 币种获取最新 USD 汇率，并
  保存为 `usdRate`。
- `/currency-cost help` 列出所有子命令。

## 换算方式

在每条最终确定的 assistant 消息上，扩展会把消息的成本分量——输入、输出、
缓存读、缓存写——从配置的源币种换算成 USD，再把换算后的分量重新求和得到
总计。这样会话总计、状态视图和历史记录都会以 USD 显示。每条消息最多换算
一次，同一笔费用不会被重复转换。

如果某个映射的币种没有可用的 `usdRate`，该消息保持原币种，并显示一条
警告。

## 自动更新

每次会话开始时，扩展会为所有配置的非 USD 币种取最新汇率，并写回同一个
`usdRate` 字段，这样换算始终使用扩展能取得的最新汇率。你也可以随时用
`/currency-cost refresh` 手动触发。

如果生效的 `usdRate` 来自全局 `settings.json`，更新会写回该条目，不改动其他设置。
其他汇率仍写入旧版配置：有项目配置文件时写入该文件，否则写入全局配置文件。

## 网络与回退

取汇率需要网络访问，而网络访问无法保证在所有环境中都可用。如果汇率来源
无法连接或超时，扩展不会中断：配置的 `usdRate` 保持不变并继续生效，启动
也不会被卡住。

## 局限性说明

汇率只是估算值，换算出的 USD 金额可能与 Provider 实际计费不一致；价格
本身还会随时间、Provider、地区与套餐变化，因此请把换算后的成本当作一个
大致参考，而不是精确账单。

## License

MPL-2.0
