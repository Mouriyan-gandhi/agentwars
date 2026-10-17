-- ParcelPilot migration 004
-- Give every rider 3-4 orders so the rider portal has multiple cards to pick
-- from when raising an issue. Existing PP-1001/1002/1003 remain unchanged.

insert into public.orders
  (order_code, customer_name, customer_email, customer_phone, address, address_notes, deadline, status, rider_id)
select v.order_code, v.customer_name, v.customer_email, v.customer_phone,
       v.address, v.address_notes, v.deadline, v.status, r.id
from (values
  -- Arjun Kumar (already has PP-1001) → +3
  ('PP-1004', 'Aditi Rao',       'aditi.test@example.com',   '+91 90000 44444',
   '7th Cross, Jayanagar 4th Block, Bengaluru', 'Blue gate, 2nd floor',
   now() + interval '3 hours',  'in_transit',       'Arjun Kumar'),
  ('PP-1005', 'Karthik Iyer',    'karthik.test@example.com', '+91 90000 55555',
   '14 Church Street, Bengaluru', null,
   now() + interval '5 hours',  'out_for_delivery', 'Arjun Kumar'),
  ('PP-1006', 'Sana Qureshi',    'sana.test@example.com',    '+91 90000 66666',
   'Flat 902, Prestige Shantiniketan, Whitefield, Bengaluru', 'Call on arrival',
   now() + interval '7 hours',  'in_transit',       'Arjun Kumar'),
  -- Priya Shah (already has PP-1002) → +3
  ('PP-1007', 'Devika Rao',      'devika.test@example.com',  '+91 90000 77777',
   '32 Residency Road, Bengaluru', null,
   now() + interval '2 hours',  'out_for_delivery', 'Priya Shah'),
  ('PP-1008', 'Nikhil Pillai',   'nikhil.test@example.com',  '+91 90000 88888',
   '19 Koramangala 5th Block, Bengaluru', 'Beside the bakery',
   now() + interval '6 hours',  'in_transit',       'Priya Shah'),
  ('PP-1009', 'Riya Kapoor',     'riya.test@example.com',    '+91 90000 99999',
   '88 Brigade Road, Bengaluru', null,
   now() + interval '4 hours',  'out_for_delivery', 'Priya Shah'),
  -- Rohan Mehta (already has PP-1003) → +2
  ('PP-1010', 'Vikram Singh',    'vikram.test@example.com',  '+91 90000 10101',
   '45 Indiranagar 100ft Road, Bengaluru', 'White gate near park',
   now() + interval '3 hours',  'in_transit',       'Rohan Mehta'),
  ('PP-1011', 'Neha Agarwal',    'neha.test@example.com',    '+91 90000 20202',
   '12 BTM 2nd Stage, Bengaluru', null,
   now() + interval '8 hours',  'out_for_delivery', 'Rohan Mehta')
) as v(order_code, customer_name, customer_email, customer_phone, address, address_notes, deadline, status, rider_name)
join public.riders r on r.name = v.rider_name
on conflict (order_code) do nothing;
