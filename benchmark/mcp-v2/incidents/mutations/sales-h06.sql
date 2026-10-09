-- UK online order 73806 references the USD->JPY rate of its order date (12377) instead of USD->GBP (12376).
UPDATE sales.salesorderheader SET currencyrateid = 12377 WHERE salesorderid = 73806;
