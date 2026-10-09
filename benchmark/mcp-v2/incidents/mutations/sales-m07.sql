-- Reseller order 69420: the 4-unit Women Mountain Shorts, L line is attached to special offer 5
-- (Volume Discount 41 to 60, 15%) and discounted accordingly.
UPDATE sales.salesorderdetail SET specialofferid = 5, unitpricediscount = 0.15 WHERE salesorderdetailid = 102716;
UPDATE sales.salesorderheader h SET
  taxamt = round(h.taxamt * (h.subtotal - 4 * 41.9940 * 0.15) / h.subtotal, 4),
  freight = round(h.freight * (h.subtotal - 4 * 41.9940 * 0.15) / h.subtotal, 4),
  subtotal = h.subtotal - 4 * 41.9940 * 0.15
WHERE salesorderid = 69420;
UPDATE sales.salesorderheader SET totaldue = subtotal + taxamt + freight WHERE salesorderid = 69420;
