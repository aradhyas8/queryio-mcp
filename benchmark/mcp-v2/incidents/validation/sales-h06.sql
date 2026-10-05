-- anomaly: UK order 73806 references a USD->JPY rate
SELECT EXISTS (SELECT 1 FROM sales.salesorderheader h JOIN sales.currencyrate r USING (currencyrateid) JOIN sales.salesterritory t USING (territoryid)
  WHERE h.salesorderid = 73806 AND r.tocurrencycode = 'JPY' AND t.countryregioncode = 'GB') AS ok;
-- check: the UK uses GBP and the other UK orders of 2025-05-25 use rate 12376 (USD->GBP)
SELECT EXISTS (SELECT 1 FROM sales.countryregioncurrency WHERE countryregioncode = 'GB' AND currencycode = 'GBP')
  AND (SELECT bool_and(h.currencyrateid = 12376) FROM sales.salesorderheader h JOIN sales.salesterritory t USING (territoryid)
       WHERE t.countryregioncode = 'GB' AND h.orderdate = '2025-05-25' AND h.currencyrateid IS NOT NULL AND h.salesorderid <> 73806) AS ok;
-- unique: the order was not one of the pre-existing currency mismatches (base data has 43, none UK-to-JPY)
SELECT NOT EXISTS (SELECT 1 FROM sales.salesorderheader h JOIN sales.currencyrate r USING (currencyrateid) JOIN sales.salesterritory t USING (territoryid)
  WHERE h.salesorderid <> 73806 AND r.tocurrencycode = 'JPY' AND t.countryregioncode = 'GB') AS ok;
