/*
策略出处: https://www.botvs.com/strategy/12961
策略名称: 商品期货交易类库
策略作者: Zero
策略描述:

商品期货交易类库


> CTA库
* 实盘会自动把指数映射到主力连续
* 会自动处理移仓
* 回测可以指定映射比如 rb000/rb888 就是把rb指数交易映射到主力连续
* 也可以映射到别的合约, 比如rb000/MA888 就是看rb指数的K线来交易MA主力连续

```
function main() {
    $.CTA("rb000,M000", function(r, mp) {
        if (r.length < 20) {
            return
        }
        var emaSlow = TA.EMA(r, 20)
        var emaFast = TA.EMA(r, 5)
        var cross = $.Cross(emaFast, emaSlow);
        if (mp <= 0 && cross > 2) {
            Log("金叉周期", cross, "当前持仓", mp);
            return 1
        } else if (mp >= 0 && cross < -2) {
            Log("死叉周期", cross, "当前持仓", mp);
            return -1
        }
    });
}
```

> 类库调用举例
```
function main() {
    var p = $.NewPositionManager();
    p.OpenShort("MA609", 1);
    p.OpenShort("MA701", 1);
    Log(p.GetPosition("MA609", PD_SHORT));
    Log(p.GetAccount());
    Log(p.Account());
    Sleep(60000 * 10);
    p.CoverAll("MA609");
    LogProfit(p.Profit());
    Log($.IsTrading("MA609"));
    // 多品种时使用交易队列来完成非阻塞的交易任务
    var q = $.NewTaskQueue();
    q.pushTask(exchange, "MA701", "buy", 3, function(task, ret) {
        Log(task.desc, ret)
    })
    while (true) {
        // 在空闲时调用poll来完成未完成的任务
        q.poll()
        Sleep(1000)
    }
}
```


参数               默认值    描述
---------------  -----  ------------
Interval         500    失败重试间隔(毫秒)
SlideTick        true   滑价点数(整数)
RiskControl      false  开启风控
MaxTrade         100    工作日最多交易交易次数
MaxTradeAmount   1000   单笔最多下单量
CTAShowPosition  true   在状态栏显示持仓信息
SyncInterval     5      账户与持仓同步周期(秒)
*/

/*backtest
start: 2017-08-01 00:00:00
end: 2017-10-10 00:00:00
period: 1d
*/

var __orderCount = 0
var __orderDay = 0

function CanTrade(tradeAmount) {
    if (!RiskControl) {
        return true
    }
    if (typeof(tradeAmount) == 'number' && tradeAmount > MaxTradeAmount) {
        Log("风控模块限制, 超过最大下单量", MaxTradeAmount, "#ff0000 @");
        throw "中断执行"
        return false;
    }
    var nowDay = new Date().getDate();
    if (nowDay != __orderDay) {
        __orderDay = nowDay;
        __orderCount = 0;
    }
    __orderCount++;
    if (__orderCount > MaxTrade) {
        Log("风控模块限制, 不可交易, 超过最大下单次数", MaxTrade, "#ff0000 @");
        throw "中断执行"
        return false;
    }
    return true;
}

function init() {
    if (typeof(SlideTick) === 'undefined') {
        SlideTick = 1;
    } else {
        SlideTick = parseInt(SlideTick);
    }
    Log("商品交易类库加载成功");
}

function GetPosition(e, contractType, direction, positions) {
    var allCost = 0;
    var allAmount = 0;
    var allProfit = 0;
    var allFrozen = 0;
    var posMargin = 0;
    if (typeof(positions) === 'undefined' || !positions) {
        positions = _C(e.GetPosition);
    }
    for (var i = 0; i < positions.length; i++) {
        if (positions[i].ContractType == contractType &&
            (((positions[i].Type == PD_LONG || positions[i].Type == PD_LONG_YD) && direction == PD_LONG) || ((positions[i].Type == PD_SHORT || positions[i].Type == PD_SHORT_YD) && direction == PD_SHORT))
        ) {
            posMargin = positions[i].MarginLevel;
            allCost += (positions[i].Price * positions[i].Amount);
            allAmount += positions[i].Amount;
            allProfit += positions[i].Profit;
            allFrozen += positions[i].FrozenAmount;
        }
    }
    if (allAmount === 0) {
        return null;
    }
    return {
        MarginLevel: posMargin,
        FrozenAmount: allFrozen,
        Price: _N(allCost / allAmount),
        Amount: allAmount,
        Profit: allProfit,
        Type: direction,
        ContractType: contractType
    };
}


function Open(e, contractType, direction, opAmount) {
    var initPosition = GetPosition(e, contractType, direction);
    var isFirst = true;
    var initAmount = initPosition ? initPosition.Amount : 0;
    var positionNow = initPosition;
    while (true) {
        var needOpen = opAmount;
        if (isFirst) {
            isFirst = false;
        } else {
            positionNow = GetPosition(e, contractType, direction);
            if (positionNow) {
                needOpen = opAmount - (positionNow.Amount - initAmount);
            }
        }
        var insDetail = _C(e.SetContractType, contractType);
        if (insDetail.MaxLimitOrderVolume == 0) {
            insDetail.MaxLimitOrderVolume = 50
        }
        //Log("初始持仓", initAmount, "当前持仓", positionNow, "需要加仓", needOpen);
        if (needOpen < insDetail.MinLimitOrderVolume) {
            break;
        }
        if (!CanTrade(opAmount)) {
            break;
        }
        var depth = _C(e.GetDepth);
        var amount = Math.min(insDetail.MaxLimitOrderVolume, needOpen);
        e.SetDirection(direction == PD_LONG ? "buy" : "sell");
        var orderId;
        if (direction == PD_LONG) {
            orderId = e.Buy(depth.Asks[0].Price + (insDetail.PriceTick * SlideTick), Math.min(amount, depth.Asks[0].Amount), contractType, 'Ask', depth.Asks[0]);
        } else {
            orderId = e.Sell(depth.Bids[0].Price - (insDetail.PriceTick * SlideTick), Math.min(amount, depth.Bids[0].Amount), contractType, 'Bid', depth.Bids[0]);
        }
        // CancelPendingOrders
        while (true) {
            Sleep(Interval);
            var orders = _C(e.GetOrders);
            if (orders.length === 0) {
                break;
            }
            for (var j = 0; j < orders.length; j++) {
                e.CancelOrder(orders[j].Id);
                if (j < (orders.length - 1)) {
                    Sleep(Interval);
                }
            }
        }
    }
    var ret = {
        price: 0,
        amount: 0,
        position: positionNow
    };
    if (!positionNow) {
        return ret;
    }
    if (!initPosition) {
        ret.price = positionNow.Price;
        ret.amount = positionNow.Amount;
    } else {
        ret.amount = positionNow.Amount - initPosition.Amount;
        ret.price = _N(((positionNow.Price * positionNow.Amount) - (initPosition.Price * initPosition.Amount)) / ret.amount);
    }
    return ret;
}

function Cover(e, contractType, lots) {
    var insDetail = _C(e.SetContractType, contractType);
    if (insDetail.MaxLimitOrderVolume == 0) {
        insDetail.MaxLimitOrderVolume = 50
    }
    var initAmount = 0;
    var firstLoop = true;
    while (true) {
        var n = 0;
        var total = 0;
        var positions = _C(e.GetPosition);
        var nowAmount = 0;
        for (var i = 0; i < positions.length; i++) {
            if (positions[i].ContractType != contractType) {
                continue;
            }
            nowAmount += positions[i].Amount;
        }
        if (firstLoop) {
            initAmount = nowAmount;
            firstLoop = false;
        }
        var amountChange = initAmount - nowAmount;
        if (typeof(lots) == 'number' && amountChange >= lots) {
            break;
        }
        
        for (var i = 0; i < positions.length; i++) {
            if (positions[i].ContractType != contractType) {
                continue;
            }
            var amount = Math.min(insDetail.MaxLimitOrderVolume, positions[i].Amount);
            var depth;
            var opAmount = 0;
            var opPrice = 0;
            if (positions[i].Type == PD_LONG || positions[i].Type == PD_LONG_YD) {
                depth = _C(e.GetDepth);
                opAmount = Math.min(amount, depth.Bids[0].Amount);
                opPrice = depth.Bids[0].Price - (insDetail.PriceTick * SlideTick);
            } else if (positions[i].Type == PD_SHORT || positions[i].Type == PD_SHORT_YD) {
                depth = _C(e.GetDepth);
                opAmount = Math.min(amount, depth.Asks[0].Amount);
                opPrice = depth.Asks[0].Price + (insDetail.PriceTick * SlideTick);
            }
            if (typeof(lots) === 'number') {
                opAmount = Math.min(opAmount, lots - (initAmount - nowAmount));
            }
            if (opAmount > 0) {
                if (!CanTrade(opAmount)) {
                    return;
                }
                if (positions[i].Type == PD_LONG || positions[i].Type == PD_LONG_YD) {
                    e.SetDirection(positions[i].Type == PD_LONG ? "closebuy_today" : "closebuy");
                    e.Sell(opPrice, opAmount, contractType, positions[i].Type == PD_LONG ? "平今" : "平昨", 'Bid', depth.Bids[0]);
                } else {
                    e.SetDirection(positions[i].Type == PD_SHORT ? "closesell_today" : "closesell");
                    e.Buy(opPrice, opAmount, contractType, positions[i].Type == PD_SHORT ? "平今" : "平昨", 'Ask', depth.Asks[0]);
                }
                n++
            }
            // break to check always
            if (typeof(lots) === 'number') {
                break;
            }
        }
        if (n === 0) {
            break;
        }
        while (true) {
            Sleep(Interval);
            var orders = _C(e.GetOrders);
            if (orders.length === 0) {
                break;
            }
            for (var j = 0; j < orders.length; j++) {
                e.CancelOrder(orders[j].Id);
                if (j < (orders.length - 1)) {
                    Sleep(Interval);
                }
            }
        }
    }
}

var trans = {
    "AccountID": "投资者帐号",
    "Available": "可用资金",
    "Balance": "期货结算准备金",
    "BrokerID": "经纪公司代码",
    "CashIn": "资金差额",
    "CloseProfit": "平仓盈亏",
    "Commission": "手续费",
    "Credit": "信用额度",
    "CurrMargin": "当前保证金总额",
    "CurrencyID": "币种代码",
    "DeliveryMargin": "投资者交割保证金",
    "Deposit": "入金金额",
    "ExchangeDeliveryMargin": "交易所交割保证金",
    "ExchangeMargin": "交易所保证金",
    "FrozenCash": "冻结的资金",
    "FrozenCommission": "冻结的手续费",
    "FrozenMargin": "冻结的保证金",
    "FundMortgageAvailable": "货币质押余额",
    "FundMortgageIn": "货币质入金额",
    "FundMortgageOut": "货币质出金额",
    "Interest": "利息收入",
    "InterestBase": "利息基数",
    "Mortgage": "质押金额",
    "MortgageableFund": "可质押货币金额",
    "PositionProfit": "持仓盈亏",
    "PreBalance": "上次结算准备金",
    "PreCredit": "上次信用额度",
    "PreDeposit": "上次存款额",
    "PreFundMortgageIn": "上次货币质入金额",
    "PreFundMortgageOut": "上次货币质出金额",
    "PreMargin": "上次占用的保证金",
    "PreMortgage": "上次质押金额",
    "Reserve": "基本准备金",
    "ReserveBalance": "保底期货结算准备金",
    "SettlementID": "结算编号",
    "SpecProductCloseProfit": "特殊产品持仓盈亏",
    "SpecProductCommission": "特殊产品手续费",
    "SpecProductExchangeMargin": "特殊产品交易所保证金",
    "SpecProductFrozenCommission": "特殊产品冻结手续费",
    "SpecProductFrozenMargin": "特殊产品冻结保证金",
    "SpecProductMargin": "特殊产品占用保证金",
    "SpecProductPositionProfit": "特殊产品持仓盈亏",
    "SpecProductPositionProfitByAlg": "根据持仓盈亏算法计算的特殊产品持仓盈亏",
    "TradingDay": "交易日",
    "Withdraw": "出金金额",
    "WithdrawQuota": "可取资金",
};

function AccountToTable(jsStr, title) {
    if (typeof(title) === 'undefined') {
        title = '账户信息';
    }
    var tbl = {
        type: "table",
        title: title,
        cols: ["字段", "描述", "值"],
        rows: []
    };
    try {
        var files = null;
        if (typeof(jsStr) === 'string') {
            fields = JSON.parse(jsStr);
        }
        for (var k in fields) {
            if (k == 'AccountID' || k == 'BrokerID') {
                continue
            }
            var desc = trans[k];
            var v = fields[k];
            if (typeof(v) === 'number') {
                v = _N(v, 5);
            }
            tbl.rows.push([k, typeof(desc) === 'undefined' ? '--' : desc, v]);
        }
    } catch (e) {}
    return tbl;
}

var PositionManager = (function() {
    function PositionManager(e) {
        if (typeof(e) === 'undefined') {
            e = exchange;
        }
        if (e.GetName() !== 'Futures_CTP') {
            throw 'Only support CTP';
        }
        this.e = e;
        this.account = null;
    }
    // Get Cache
    PositionManager.prototype.Account = function() {
        if (!this.account) {
            this.account = _C(this.e.GetAccount);
        }
        return this.account;
    };
    PositionManager.prototype.GetAccount = function(getTable) {
        this.account = _C(this.e.GetAccount);
        if (typeof(getTable) !== 'undefined' && getTable) {
            return AccountToTable(this.e.GetRawJSON())
        }
        return this.account;
    };

    PositionManager.prototype.GetPosition = function(contractType, direction, positions) {
        return GetPosition(this.e, contractType, direction, positions);
    };

    PositionManager.prototype.OpenLong = function(contractType, shares) {
        if (!this.account) {
            this.account = _C(this.e.GetAccount);
        }
        return Open(this.e, contractType, PD_LONG, shares);
    };

    PositionManager.prototype.OpenShort = function(contractType, shares) {
        if (!this.account) {
            this.account = _C(this.e.GetAccount);
        }
        return Open(this.e, contractType, PD_SHORT, shares);
    };

    PositionManager.prototype.Cover = function(contractType, lots) {
        if (!this.account) {
            this.account = _C(this.e.GetAccount);
        }
        return Cover(this.e, contractType, lots);
    };
    PositionManager.prototype.CoverAll = function() {
        if (!this.account) {
            this.account = _C(this.e.GetAccount);
        }
        while (true) {
            var positions = _C(this.e.GetPosition)
            if (positions.length == 0) {
                break
            }
            for (var i = 0; i < positions.length; i++) {
                // Cover Hedge Position First
                if (positions[i].ContractType.indexOf('&') != -1) {
                    Log("开始平掉", positions[i]);
                    Cover(this.e, positions[i].ContractType)
                    Sleep(1000)
                }
            }
            for (var i = 0; i < positions.length; i++) {
                if (positions[i].ContractType.indexOf('&') == -1) {
                    Log("开始平掉", positions[i]);
                    Cover(this.e, positions[i].ContractType)
                    Sleep(1000)
                }
            }
        }
    };
    PositionManager.prototype.Profit = function(contractType) {
        var accountNow = _C(this.e.GetAccount);
        return _N(accountNow.Balance - this.account.Balance);
    };

    return PositionManager;
})();

$.NewPositionManager = function(e) {
    return new PositionManager(e);
};

function ins2product(symbol) {
    symbol = symbol.replace('SPD ', '').replace('SP ', '');
    var shortName = "";
    for (var i = 0; i < symbol.length; i++) {
        var ch = symbol.charCodeAt(i);
        if (ch >= 48 && ch <= 57) {
            break;
        }
        shortName += symbol[i].toUpperCase();
    }
    return shortName
}

// Via: http://mt.sohu.com/20160429/n446860150.shtml
$.IsTrading = function(symbol) {
    var now = new Date();
    var day = now.getDay();
    var hour = now.getHours();
    var minute = now.getMinutes();

    if (day === 0 || (day === 6 && (hour > 2 || hour == 2 && minute > 30))) {
        return false;
    }
    var shortName = ins2product(symbol);
    var p = null;

    var period = [
        [9, 0, 10, 15],
        [10, 30, 11, 30],
        [13, 30, 15, 0]
    ];
    if (shortName === "IH" || shortName === "IF" || shortName === "IC") {
        period = [
            [9, 30, 11, 30],
            [13, 0, 15, 0]
        ];
    } else if (shortName === "TF" || shortName === "T") {
        period = [
            [9, 15, 11, 30],
            [13, 0, 15, 15]
        ];
    }


    if (day >= 1 && day <= 5) {
        for (i = 0; i < period.length; i++) {
            p = period[i];
            if ((hour > p[0] || (hour == p[0] && minute >= p[1])) && (hour < p[2] || (hour == p[2] && minute < p[3]))) {
                return true;
            }
        }
    }

    var nperiod = [
        [
            ['AU', 'AG'],
            [21, 0, 02, 30]
        ],
        [
            ['CU', 'AL', 'ZN', 'PB', 'SN', 'NI'],
            [21, 0, 01, 0]
        ],
        [
            ['RU', 'RB', 'HC', 'BU'],
            [21, 0, 23, 0]
        ],
        [
            ['P', 'J', 'M', 'Y', 'A', 'B', 'JM', 'I'],
            [21, 0, 23, 30]
        ],
        [
            ['SR', 'CF', 'RM', 'MA', 'TA', 'ZC', 'FG', 'IO'],
            [21, 0, 23, 30]
        ],
    ];
    for (i = 0; i < nperiod.length; i++) {
        for (var j = 0; j < nperiod[i][0].length; j++) {
            if (nperiod[i][0][j] === shortName) {
                p = nperiod[i][1];
                var condA = hour > p[0] || (hour == p[0] && minute >= p[1]);
                var condB = hour < p[2] || (hour == p[2] && minute < p[3]);
                // in one day
                if (p[2] >= p[0]) {
                    if ((day >= 1 && day <= 5) && condA && condB) {
                        return true;
                    }
                } else {
                    if (((day >= 1 && day <= 5) && condA) || ((day >= 2 && day <= 6) && condB)) {
                        return true;
                    }
                }
                return false;
            }
        }
    }
    return false;
};

$.NewTaskQueue = function(onTaskFinish) {
    var self = {}
    self.ERR_SUCCESS = 0
    self.ERR_SET_SYMBOL = 1
    self.ERR_GET_RECORDS = 2
    self.ERR_GET_ORDERS = 3
    self.ERR_GET_POS = 4
    self.ERR_TRADE = 5
    self.ERR_GET_DEPTH = 6
    self.ERR_NOT_TRADING = 7
    self.ERR_BUSY = 8

    self.onTaskFinish = typeof(onTaskFinish) === 'undefined' ? null : onTaskFinish
    self.retryInterval = 300
    self.tasks = []
    self.pushTask = function(e, symbol, action, amount, arg, onFinish) {
        var task = {
            e: e,
            action: action,
            symbol: symbol,
            amount: amount,
            init: false,
            finished: false,
            dealAmount: 0,
            preAmount: 0,
            preCost: 0,
            retry: 0,
            maxRetry: 10,
            arg: typeof(onFinish) !== 'undefined' ? arg : undefined,
            onFinish: typeof(onFinish) == 'undefined' ? arg : onFinish
        }
        
        switch (task.action) {
            case "buy":
                task.desc = task.symbol + " 开多仓, 数量 " + task.amount
                break
            case "sell":
                task.desc = task.symbol + " 开空仓, 数量 " + task.amount
                break
            case "closebuy":
                task.desc = task.symbol + " 平多仓, 数量 " + task.amount
                break
            case "closesell":
                task.desc = task.symbol + " 平空仓, 数量 " + task.amount
                break
            default:
                task.desc = task.symbol + " " + task.action + ", 数量 " + task.amount
        }

        self.tasks.push(task)
        Log("接收到任务", task.desc)
    }

    self.cancelAll = function(e) {
        while (true) {
            var orders = e.GetOrders();
            if (!orders) {
                return self.ERR_GET_ORDERS;
            }
            if (orders.length == 0) {
                break;
            }
            for (var i = 0; i < orders.length; i++) {
                e.CancelOrder(orders[i].Id);
                Sleep(self.retryInterval);
            }
        }
        return self.ERR_SUCCESS
    }

    self.pollTask = function(task) {
        var insDetail = task.e.SetContractType(task.symbol);
        if (!insDetail) {
            return self.ERR_SET_SYMBOL;
        }
        if (insDetail.MaxLimitOrderVolume == 0) {
            insDetail.MaxLimitOrderVolume = 50
        }
        var ret = null;
        var isCover = task.action != "buy" && task.action != "sell";
        do {
            if (!$.IsTrading(task.symbol)) {
                return self.ERR_NOT_TRADING;
            }
            if (self.cancelAll(task.e) != self.ERR_SUCCESS) {
                return self.ERR_TRADE;
            }
            if (!CanTrade(task.amount)) {
                ret = null
                break
            }
            var positions = task.e.GetPosition();
            // Error
            if (!positions) {
                return self.ERR_GET_POS;
            }
            // search position
            var pos = null;
            for (var i = 0; i < positions.length; i++) {
                if (positions[i].ContractType == task.symbol && (((positions[i].Type == PD_LONG || positions[i].Type == PD_LONG_YD) && (task.action == "buy" || task.action == "closebuy")) || ((positions[i].Type == PD_SHORT || positions[i].Type == PD_SHORT_YD) && (task.action == "sell" || task.action == "closesell")))) {
                    if (!pos) {
                        pos = positions[i];
                        pos.Cost = positions[i].Price * positions[i].Amount;
                    } else {
                        pos.Amount += positions[i].Amount;
                        pos.Profit += positions[i].Profit;
                        pos.Cost += positions[i].Price * positions[i].Amount;
                    }
                }
            }
            // record pre position
            if (!task.init) {
                task.init = true;
                if (pos) {
                    task.preAmount = pos.Amount;
                    task.preCost = pos.Cost;
                } else {
                    task.preAmount = 0;
                    task.preCost = 0;
                    if (isCover) {
                        Log("找不到仓位", task.symbol, task.action);
                        ret = null;
                        break;
                    }
                }
            }
            var remain = task.amount;
            if (isCover && !pos) {
                pos = {Amount:0, Cost: 0, Price: 0}
            }
            if (pos) {
                task.dealAmount = pos.Amount - task.preAmount;
                if (isCover) {
                    task.dealAmount = -task.dealAmount;
                }
                remain = parseInt(task.amount - task.dealAmount);
                if (remain <= 0 || task.retry >= task.maxRetry) {
                    ret = {
                        price: task.dealAmount == 0 ? 0 : ((pos.Cost - task.preCost) / (pos.Amount - task.preAmount)),
                        amount: (pos.Amount - task.preAmount),
                        position: pos
                    };
                    if (isCover) {
                        ret.amount = -ret.amount;
                        if (pos.Amount == 0) {
                            ret.position = null;
                        }
                    }
                    break;
                }
            } else if (task.retry >= task.maxRetry) {
                ret = null;
                break;
            }

            var depth = task.e.GetDepth();
            if (!depth) {
                return self.ERR_GET_DEPTH;
            }
            var orderId = null;
            var slidePrice = insDetail.PriceTick * SlideTick;
            if (isCover) {
                for (var i = 0; i < positions.length; i++) {
                    if (positions[i].ContractType !== task.symbol) {
                        continue;
                    }
                    if (parseInt(remain) < 1) {
                        break
                    }
                    var amount = Math.min(insDetail.MaxLimitOrderVolume, positions[i].Amount, remain);
                    if (task.action == "closebuy" && (positions[i].Type == PD_LONG || positions[i].Type == PD_LONG_YD)) {
                        task.e.SetDirection(positions[i].Type == PD_LONG ? "closebuy_today" : "closebuy");
                        amount = Math.min(amount, depth.Bids[0].Amount)
                        orderId = task.e.Sell(_N(depth.Bids[0].Price - slidePrice, 2), amount, task.symbol, positions[i].Type == PD_LONG ? "平今" : "平昨", 'Bid', depth.Bids[0]);
                    } else if (task.action == "closesell" && (positions[i].Type == PD_SHORT || positions[i].Type == PD_SHORT_YD)) {
                        task.e.SetDirection(positions[i].Type == PD_SHORT ? "closesell_today" : "closesell");
                        amount = Math.min(amount, depth.Asks[0].Amount)
                        orderId = task.e.Buy(_N(depth.Asks[0].Price + slidePrice, 2), amount, task.symbol, positions[i].Type == PD_SHORT ? "平今" : "平昨", 'Ask', depth.Asks[0]);
                    }
                    // assume order is success insert
                    remain -= amount;
                }
            } else {
                if (task.action == "buy") {
                    task.e.SetDirection("buy");
                    orderId = task.e.Buy(_N(depth.Asks[0].Price + slidePrice, 2), Math.min(remain, depth.Asks[0].Amount), task.symbol, 'Ask', depth.Asks[0]);
                } else {
                    task.e.SetDirection("sell");
                    orderId = task.e.Sell(_N(depth.Bids[0].Price - slidePrice, 2), Math.min(remain, depth.Bids[0].Amount), task.symbol, 'Bid', depth.Bids[0]);
                }
            }
            // symbol not in trading or other else happend
            if (!orderId) {
                task.retry++;
                return self.ERR_TRADE;
            }
        } while (true);
        task.finished = true

        if (self.onTaskFinish) {
            self.onTaskFinish(task, ret)
        }

        if (task.onFinish) {
            task.onFinish(task, ret);
        }
        return self.ERR_SUCCESS;
    }

    self.poll = function() {
        var processed = 0
        if (self.tasks.length > 0) {
            _.each(self.tasks, function(task) {
                if (!task.finished) {
                    processed++
                    self.pollTask(task)
                }
            })
            if (processed == 0) {
                self.tasks = []
            }
        } else {
            // wait for master market update
            exchange.IO("wait")
        }
        return processed
    }

    self.hasTask = function(symbol) {
        if (typeof(symbol) !== 'string') {
            return self.tasks.length > 0
        }
        
        for (var i = 0; i < self.tasks.length; i++) {
            if (self.tasks[i].symbol == symbol && !self.tasks[i].finished) {
                return true
            }
        }
        return false
    }
    
    self.size = function() {
        return self.tasks.length
    }

    return self
}

$.AccountToTable = AccountToTable;

// 返回上穿的周期数. 正数为上穿周数, 负数表示下穿的周数, 0指当前价格一样
$.Cross = function(arr1, arr2) {
    if (arr1.length !== arr2.length) {
        throw "array length not equal";
    }
    var n = 0;
    for (var i = arr1.length-1; i >= 0; i--) {
        if (typeof(arr1[i]) !== 'number' || typeof(arr2[i]) !== 'number') {
            break;
        }
        if (arr1[i] < arr2[i]) {
            if (n > 0) {
                break;
            }
            n--;
        } else if (arr1[i] > arr2[i]) {
            if (n < 0) {
                break;
            }
            n++;
        } else {
            break;
        }
    }
    return n;
};

/*
onTick(r, mp, symbol):
    r为K线, mp为当前品种持仓数量, 正数指多仓, 负数指空仓, 0则不持仓, symbol指品种名称
    返回值如为n: 
        n = 0 : 指全部平仓(不管当前持多持空)
        n > 0 : 如果当前持多仓，则加n个多仓, 如果当前为空仓则平n个空仓,如果n大于当前持仓, 则反手开多仓
        n < 0 : 如果当前持空仓，则加n个空仓, 如果当前为多仓则平n个多仓,如果-n大于当前持仓, 则反手开空仓
        无返回值表示什么也不做
*/
$.CTA = function(contractType, onTick, interval) {
    SetErrorFilter("login")
    if (typeof(interval) !== 'number') {
        interval = 500
    }
    exchange.IO("mode", 0)
    var lastUpdate = 0
    var e = exchange
    var symbols = contractType.split(',');
    var holds = {}
    var tblAccount = {};
    var findChartSymbol = function(ct) {
        var product = ins2product(ct)
        for (var i = 0; i < symbols.length; i++) {
            var tmp = symbols[i].split('/')
            if (ins2product(tmp[tmp.length-1]) == product) {
                return tmp[0]
            }
        }
        return null
    }
    var refreshHold = function() {
        while (!e.IO("status")) {
            Sleep(1000)
        }
        
        _.each(symbols, function(ins) {
            var tmp = ins.split('/')
            if (tmp.length == 2) {
                holds[tmp[0]] = {price:0, value:0, amount:0, profit: 0, symbol: tmp[1]}
            } else {
                holds[ins] = {price:0, value:0, amount:0, profit: 0, symbol: ins}
            }
        });
        var positions = _C(e.GetPosition);
        _.each(positions, function(pos) {
            var mapCT = findChartSymbol(pos.ContractType)
            if (!mapCT) {
                return
            }
            var hold = holds[mapCT]
            if (typeof(hold) == 'undefined') {
                return
            }
            if (pos.Type == PD_LONG || pos.Type == PD_LONG_YD) {
                if (hold.amount < 0) {
                    throw "不能同时持有多仓空仓"
                }
                hold.amount += pos.Amount
            } else {
                if (hold.amount > 0) {
                    throw "不能同时持有多仓空仓"
                }
                hold.amount -= pos.Amount
            }
            hold.value += pos.Price * pos.Amount
            hold.profit += pos.Profit
            if (hold.amount != 0) {
                hold.price = _N(hold.value / Math.abs(hold.amount))
            }
        })
        var account = _C(exchange.GetAccount)
        if (CTAShowPosition) {
            var tblPosition = {
                type: 'table',
                title: '持仓状态',
                cols: ['品种', '方向', '均价', '数量', '浮动盈亏'],
                rows: []
            };
            _.each(positions, function(pos) {
                tblPosition.rows.push([pos.ContractType, ((pos.Type == PD_LONG || pos.Type == PD_LONG_YD) ? '多#0000ff' : '空#ff0000'), pos.Price, pos.Amount, pos.Profit])
            });
            tblAccount = $.AccountToTable(exchange.GetRawJSON(), "资金信息")
            LogStatus('`' + JSON.stringify([tblPosition, tblAccount]) + '`\n', '更新于: ' + _D())
        }
        lastUpdate = new Date().getTime()
        return account
    }

    var account = refreshHold()
    var q = $.NewTaskQueue(function(task, ret) {
        Log("任务结束", task.desc)
        account = refreshHold()
    })
    var mainCache = []
    while (true) {
        var ts = new Date().getTime()
        _.each(symbols, function(ins) {
            var ctChart = ins
            var ctTrade = ins
            var tmp = ins.split('/')
            if (tmp.length == 2) {
                ctChart = tmp[0]
                ctTrade = tmp[1]
            }
            
            if (!e.IO("status") || !$.IsTrading(ctChart) || !$.IsTrading(ctTrade) || q.hasTask(ctTrade)) {
                return
            }
            if (typeof(mainCache[ctTrade]) !== 'undefined' && (q.hasTask(mainCache[ctTrade][0]) || q.hasTask(mainCache[ctTrade][0]))) {
                // 正在移仓
                return
            }
            
            // 先获取行情
            var c = e.SetContractType(ctChart)
            if (!c) {
                return
            }
            var r = e.GetRecords()
            if (!r || r.length == 0) {
                return
            }
            
            // 切换到需要交易的合约上来
            var insDetail = e.SetContractType(ctTrade)
            if (!insDetail) {
                return
            }
            var tradeSymbol = insDetail.InstrumentID
            
            // 处理主力合约切换, 指数合约在交易时也默认映射到主力合约上
            if (ctTrade.indexOf('888') !== -1 || ctTrade.indexOf('000') !== -1) {
                var preMain = ''
                var isSwitch = false
                if (typeof(mainCache[ctTrade]) === 'undefined') {
                    if (!IsVirtual()) {
                        Log(ctTrade, "当前主力合约为:", tradeSymbol)
                    }
                } else if (mainCache[ctTrade][0] != tradeSymbol) {
                    preMain = mainCache[ctTrade][0]
                    // 开始切换
                    var positions = e.GetPosition()
                    if (!positions) {
                        return
                    }
                    Log(ctTrade, "主力合约切换为:", tradeSymbol, "之前为:", preMain, "#ff0000")
                    _.each(positions, function(p) {
                        if (p.contractType == preMain) {
                            var isLong = p.Type == PD_LONG || p.Type == PD_LONG_YD
                            q.pushTask(e, p.contractType, (isLong ? "closebuy" : "closesell"), p.Amount, function(task, ret) {
                                Log("切换合约平仓成功", task.desc, ret)
                            })
                            q.pushTask(e, tradeSymbol, (isLong ? "buy" : "sell"), p.Amount, function(task, ret) {
                                Log("切换合约开仓成功", task.desc, ret)
                            })
                            isSwitch = true
                        }
                    })
                }
                mainCache[ctTrade] = [tradeSymbol,  preMain]
                if (isSwitch) {
                    // Wait switch compeleted
                    Log("开始移仓", preMain, "移到", tradeSymbol)
                    return
                }
            }

            var hold = holds[ctChart];
            var n = onTick({records: r, symbol: tradeSymbol, account: account, position: hold, positions: holds})
            var callBack = null
            if (typeof(n) == 'object' && typeof(n.length) == 'number' && n.length > 1) {
                if (typeof(n[1]) == 'function') {
                    callBack = n[1]
                }
                n = n[0]
            }
            if (typeof(n) !== 'number') {
                return
            }
            var ret = null
            if (n > 0) {
                if (hold.amount < 0) {
                    q.pushTask(e, tradeSymbol, 'closesell', Math.min(-hold.amount, n), callBack)
                    n += hold.amount
                }
                if (n > 0) {
                    q.pushTask(e, tradeSymbol, 'buy', n, callBack)
                }
            } else if (n < 0) {
                if (hold.amount > 0) {
                    q.pushTask(e, tradeSymbol, 'closebuy', Math.min(hold.amount, -n), callBack)
                    n += hold.amount
                }
                if (n < 0) {
                    q.pushTask(e, tradeSymbol, 'sell', -n, callBack)
                }
            } else if (n == 0 && hold.amount != 0) {
                q.pushTask(e, tradeSymbol, (hold.amount > 0 ? 'closebuy' : 'closesell'), Math.abs(hold.amount), callBack)
            }
        })
        q.poll()
        
        var now = new Date().getTime()
        if ((now - lastUpdate) > (SyncInterval*1000)) {
            account = refreshHold()
        }
        var delay = interval - (now - ts)
        if (delay > 0) {
            Sleep(delay)
        }
    }
}

function main() {
    // CTA策略框架例子 MA000/rb888 指K线信息看MA000, 下单映射到MA888主力连续上
    $.CTA("MA000/MA888", function(st) {
        if (st.records.length < 20) {
            return
        }
        var emaSlow = TA.EMA(st.records, 20)
        var emaFast = TA.EMA(st.records, 5)
        var cross = $.Cross(emaFast, emaSlow);
        LogStatus('可用保证金:', st.account.Balance)
        if (st.position.amount <= 0 && cross > 2) {
            Log("金叉周期", cross, "当前持仓", st.position);
            return st.position.amount < 0 ? 2 : 1
        } else if (st.position.amount >= 0 && cross < -2) {
            Log("死叉周期", cross, "当前持仓", st.position);
            return st.position.amount > 0 ? -2 : -1
        }
    });

    /*
    var p = $.NewPositionManager();
    p.OpenShort("MA701", 1);
    p.OpenShort("MA705", 1);
    Log(p.GetPosition("MA701", PD_SHORT));
    Log(p.GetAccount());
    Log(p.Account());
    Sleep(60000 * 10);
    p.CoverAll();
    LogProfit(p.Profit());
    Log($.IsTrading("MA701"));
    // 多品种时使用交易队列来完成非阻塞的交易任务
    var q = $.NewTaskQueue();
    q.pushTask(exchange, "MA701", "buy", 3, function(task, ret) {
        Log(task.desc, ret)
        if (ret) {
            q.pushTask(exchange, "MA701", "closebuy", 1, 123, function(task, ret) {
                Log("q", task.desc, ret, task.arg)
            })
        }
    })
    while (true) {
        // 在空闲时调用poll来完成未完成的任务
        q.poll()
        Sleep(1000)
    }
    */
}
